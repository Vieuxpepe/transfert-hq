/* Transfert HQ — Musique (Spotify control center). Separate from Lecteur.
   Mount via HqMusic.mount(host, {request}) using the authenticated CSRF-safe API helper.
*/
(function (root) {
  "use strict";

  var state = {
    host: null,
    request: null,
    shown: false,
    tab: "lecture",
    pollTimer: null,
    pollFailures: 0,
    pollDelay: 4000,
    authFailures: 0,
    playerError: null,
    playerSeq: 0,
    visibilityBound: false,
    abort: null,
    spotify: null,
    player: null,
    devices: [],
    playlists: [],
    playlistOffset: 0,
    playlistTotal: 0,
    playlistVisible: 12,
    playlistSort: "default",
    openPlaylist: null,
    tracks: [],
    trackOffset: 0,
    searchResults: null,
    session: null,
    presets: [],
    favorites: null,
    profile: null,
    discoveries: [],
    discoveryLimit: 10,
    mixerSources: [],
    mixerConfig: {
      length: 30,
      familiarity: 0.5,
      artist_window: 3,
      album_window: 1,
      favorites_boost: 0.15,
      max_artist_frequency: 3,
      energy_curve: "none",
      seed: ""
    },
    preferredDeviceId: "",
    bannedArtists: [],
    localSpotify: null,
    progressTimer: null,
    progressAnchorMs: 0,
    progressAnchorAt: 0,
    seeking: false,
    musicaThread: [],
    musicaBusy: false,
    studioTimer: null,
    studioDraft: {prompt: "", lyrics: "", seed: "42", duration: "90", bpm: "", language: "en"},
    renderedTab: null,
    tabScroll: {},
    pendingTabScroll: null,
    playlistsLoading: false,
    playlistDetailLoading: null,
    musicaLoaded: false,
    musicaThreadLoading: false,
    musicaRenderedCount: 0,
    musicaStick: true,
    musicaScrollBottom: true,
    viewportBound: false
  };

  var DEVICE_KEY = "hqm_preferred_device";
  var BANNED_KEY = "hqm_banned_artists";
  var VOICE_KEY = "hqm_musica_speaks";

  function loadPrefs() {
    try {
      state.preferredDeviceId = localStorage.getItem(DEVICE_KEY) || "";
      state.musicaSpeaks = localStorage.getItem(VOICE_KEY) === "true";
    } catch (_e) {
      state.preferredDeviceId = "";
    }
    loadDj();
  }

  function savePreferredDevice(id) {
    state.preferredDeviceId = id || "";
    try {
      if (state.preferredDeviceId) localStorage.setItem(DEVICE_KEY, state.preferredDeviceId);
      else localStorage.removeItem(DEVICE_KEY);
    } catch (_e) {}
  }

  function applyTaste(taste) {
    state.bannedArtists = taste.banned_artists || [];
    state.autoExcluded = taste.auto_excluded || [];
    state.historySharing = taste.history_sharing;
  }

  async function loadTaste() {
    var legacy;
    try { legacy = JSON.parse(localStorage.getItem(BANNED_KEY) || "null"); }
    catch (_e) {}
    var data = Array.isArray(legacy)
      ? await call("/api/music/taste", "POST", { migrate_bans: legacy })
      : await call("/api/music/taste");
    if (Array.isArray(legacy)) {
      try { localStorage.removeItem(BANNED_KEY); } catch (_e) {}
    }
    applyTaste(data.taste);
  }

  async function updateTaste(change) {
    var data = await call("/api/music/taste", "POST", change);
    applyTaste(data.taste);
  }

  function deviceExtras(extra) {
    var body = Object.assign({}, extra || {});
    if (!body.device_id && state.preferredDeviceId) body.device_id = state.preferredDeviceId;
    if (body.auto_device == null) body.auto_device = true;
    return body;
  }

  function friendlyPlayerError(err) {
    if (!err) return "Erreur lecteur";
    if (err.code === "spotify_no_device" || /no active device|aucun appareil/i.test(String(err.message || ""))) {
      if (!state.noDevice) {
        state.noDevice = true;
        setTimeout(function () { if (state.host && state.shown) render(); }, 0);  // the recovery banner appears
      }
      return "Aucun appareil Spotify actif. Ouvre Spotify (PC / téléphone / Fire TV), choisis « Transférer » dans Lecture, puis réessaie.";
    }
    return err.message || "Erreur lecteur";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = String(text);
    return node;
  }

  function btn(label, className, onClick) {
    var node = el("button", className || "hqm-btn", label);
    node.type = "button";
    if (onClick) node.addEventListener("click", onClick);
    return node;
  }

  function status(message, isError) {
    if (!state.host) return;
    var node = state.host.querySelector(".hqm-status");
    if (!node) return;
    node.textContent = message || "";
    node.classList.toggle("is-error", !!isError);
  }

  function fmtMs(ms) {
    ms = Math.max(0, Number(ms) || 0);
    var s = Math.floor(ms / 1000);
    var m = Math.floor(s / 60);
    s = s % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  function paintProgressFill(node) {
    if (!node) return;
    var max = Number(node.max) || 0;
    var value = Number(node.value) || 0;
    var pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
    node.style.setProperty("--hqm-fill", pct.toFixed(2) + "%");
  }

  async function call(path, method, body, request) {
    var adapter = request || state.request;
    if (typeof adapter !== "function") throw new Error("API adapter required");
    var response = await adapter({ path: path, method: method || "GET", body: body });
    var data = response && (response.body || response);
    if (!data || data.ok === false) {
      var err = new Error((data && data.error) || "Music API unavailable");
      err.code = data && data.code;
      err.status = response && response.status;
      throw err;
    }
    return data;
  }

  function coverSrc(url, width) {
    if (!url) return "";
    var src = url;
    if (String(src).indexOf("/api/spotify/image?") !== 0) {
      if (!/^https:\/\//i.test(src)) return src;
      src = "/api/spotify/image?url=" + encodeURIComponent(src);
    }
    if (width) src += "&w=" + Math.max(32, Math.min(640, Math.round(width)));
    return src;
  }

  function applyCover(img, url, width, sizes) {
    if (!img) return;
    if (!url) {
      img.removeAttribute("src");
      img.removeAttribute("srcset");
      img.dataset.coverKey = "";
      img.classList.remove("hqm-cover-loading");
      return;
    }
    var w = Math.max(32, Math.min(640, Math.round(width || 96)));
    var src = coverSrc(url, w * 2);
    img.src = src;
    img.decoding = "async";
    if (String(src).indexOf("/api/spotify/image?") === 0) {
      img.srcset = [w, w * 2, w * 3].map(function (size) {
        return coverSrc(url, size) + " " + size + "w";
      }).join(", ");
      img.sizes = sizes || (w + "px");
      if (img.dataset.coverKey !== String(url)) {
        img.dataset.coverKey = String(url);
        img.style.backgroundImage = 'url("' + coverSrc(url, 32) + '")';
        img.classList.add("hqm-cover-loading");
        if (!img.dataset.coverLoadBound) {
          img.dataset.coverLoadBound = "1";
          img.addEventListener("load", function () { img.classList.remove("hqm-cover-loading"); });
          img.addEventListener("error", function () { img.classList.remove("hqm-cover-loading"); });
        }
      }
    } else {
      img.removeAttribute("srcset");
    }
  }

  function isChatPaneWidth() {
    return root.innerWidth >= 360 && root.innerWidth <= 400;
  }

  function focusKey(node) {
    return node.getAttribute("data-hqm") || node.id ||
      ((node.getAttribute("aria-label") || node.textContent || "").trim().slice(0, 48) + "|" + node.tagName);
  }

  function captureUiState() {
    var snap = { focus: null, scrolls: {}, y: root.scrollY };
    var active = document.activeElement;
    if (active && state.host && state.host.contains(active)) {
      var entry = { key: focusKey(active), start: null, end: null };
      try {
        if (typeof active.selectionStart === "number") {
          entry.start = active.selectionStart;
          entry.end = active.selectionEnd;
        }
      } catch (_e) {}
      snap.focus = entry;
    }
    [".hqm-tabs", ".hqm-pl-list", ".hqm-chat-log"].forEach(function (selector) {
      var node = state.host.querySelector(selector);
      if (node) snap.scrolls[selector] = [node.scrollLeft, node.scrollTop];
    });
    return snap;
  }

  function restoreUiState(snap) {
    if (!snap) return;
    Object.keys(snap.scrolls).forEach(function (selector) {
      var node = state.host.querySelector(selector);
      if (!node) return;
      node.scrollLeft = snap.scrolls[selector][0];
      node.scrollTop = snap.scrolls[selector][1];
    });
    if (snap.focus) {
      var nodes = state.host.querySelectorAll("button, summary, input, textarea, select, a");
      var target = null;
      for (var i = 0; i < nodes.length; i++) {
        if (typeof nodes[i].checkVisibility === "function" && !nodes[i].checkVisibility()) continue;
        if (!nodes[i].getClientRects().length) continue;
        if (focusKey(nodes[i]) === snap.focus.key) { target = nodes[i]; break; }
      }
      if (target) {
        try { target.focus({ preventScroll: true }); } catch (_e) { target.focus(); }
        if (snap.focus.start != null && typeof target.setSelectionRange === "function") {
          try { target.setSelectionRange(snap.focus.start, snap.focus.end); } catch (_e) {}
        }
      }
    }
  }

  function keepComposerVisible() {
    var vv = root.visualViewport;
    var input = state.host && state.host.querySelector(".hqm-chat-composer textarea");
    if (!vv || !input || document.activeElement !== input) return;
    var composer = input.closest(".hqm-chat-composer");
    if (!composer) return;
    var bottom = composer.getBoundingClientRect().bottom;
    var target = vv.height + vv.offsetTop - 12;
    if (bottom > target) root.scrollBy(0, bottom - target);
  }

  function bindMusicViewport() {
    if (!state.visibilityBound) {
      state.visibilityBound = true;
      document.addEventListener("visibilitychange", function () {
        if (!state.shown) return;
        if (document.hidden) {
          stopPoll();
        } else if (!state.spotify || state.spotify.connected !== false) {
          startPoll(true);
        }
      });
    }
    var vv = root.visualViewport;
    if (!vv || state.viewportBound) return;
    state.viewportBound = true;
    var raf = 0;
    function apply() {
      raf = 0;
      var kb = Math.max(0, Math.round(root.innerHeight - vv.height - vv.offsetTop));
      document.documentElement.style.setProperty("--hq-kb", (kb > 80 ? kb : 0) + "px");
      var typing = document.activeElement && document.activeElement.matches(".hqm-chat-composer textarea");
      document.body.classList.toggle("hqm-keyboard-open", !!typing && kb > 80);
      if (typing) keepComposerVisible();
    }
    function schedule() {
      if (raf) return;
      raf = typeof root.requestAnimationFrame === "function" ? root.requestAnimationFrame(apply) : (apply(), 0);
    }
    vv.addEventListener("resize", schedule);
    vv.addEventListener("scroll", schedule);
    apply();
  }

  function stopProgressTick() {
    if (state.progressTimer) {
      clearInterval(state.progressTimer);
      state.progressTimer = null;
    }
  }

  function estimatedProgressMs() {
    var base = Number(state.progressAnchorMs) || 0;
    if (!(state.player && state.player.playing) || state.seeking) return base;
    var elapsed = Date.now() - (Number(state.progressAnchorAt) || Date.now());
    var duration = (state.player.item && state.player.item.duration_ms) || 0;
    var next = base + Math.max(0, elapsed);
    if (duration > 0) next = Math.min(duration, next);
    return next;
  }

  function paintProgress() {
    if (!state.host) return;
    var item = (state.player && state.player.item) || null;
    var ms = estimatedProgressMs();
    state.host.querySelectorAll("[data-hqm='progress']").forEach(function (progress) {
      if (item && !state.seeking) {
        progress.max = item.duration_ms || 0;
        progress.value = String(ms);
      }
      paintProgressFill(progress);
    });
    state.host.querySelectorAll("[data-hqm='times']").forEach(function (times) {
      times.textContent = item ? fmtMs(ms) + " / " + fmtMs(item.duration_ms) : "";
    });
    state.host.querySelectorAll("[data-hqm='dock-progress']").forEach(function (progress) {
      if (item) {
        progress.max = item.duration_ms || 0;
        progress.value = String(ms);
      } else {
        progress.max = 100;
        progress.value = "0";
      }
      paintProgressFill(progress);
    });
  }

  function syncProgressAnchor(fromPlayer) {
    if (!fromPlayer) return;
    state.progressAnchorMs = Number(fromPlayer.progress_ms) || 0;
    state.progressAnchorAt = Date.now();
  }

  function startProgressTick() {
    stopProgressTick();
    if (!state.shown) return;
    state.progressTimer = setInterval(function () {
      if (!state.shown || document.hidden || state.seeking) return;
      if (state.player && state.player.playing) paintProgress();
    }, 250);
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    stopProgressTick();
  }

  function startPoll(immediate) {
    stopPoll();
    if (!state.shown) return;
    if (state.spotify && state.spotify.connected === false) return;
    startProgressTick();
    state.pollFailures = 0;
    state.pollDelay = 3000;
    state.authFailures = 0;
    schedulePoll(immediate ? 0 : 3000);
  }

  function schedulePoll(delay) {
    if (!state.shown) return;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(runPoll, Math.max(0, delay));
  }

  async function runPoll() {
    state.pollTimer = null;
    if (!state.shown || document.hidden) return;
    await refreshPlayer(true);
    if (!state.shown) return;
    var err = state.playerError;
    if (!err) {
      state.pollFailures = 0;
      state.authFailures = 0;
      state.pollDelay = 3000;
      schedulePoll(3000);
      return;
    }
    state.pollFailures += 1;
    state.pollDelay = Math.min(60000, 4000 * Math.pow(2, Math.min(4, state.pollFailures - 1)));
    if (err.status === 401) {
      state.authFailures += 1;
      if (state.authFailures >= 2) {
        state.spotify = Object.assign({}, state.spotify || {}, { connected: false, error: "session_expired" });
        stopPoll();
        stopProgressTick();
        if (state.tab) render();
        status("Session Spotify expirée — reconnecte le compte.", true);
        return;
      }
    } else {
      state.authFailures = 0;
    }
    schedulePoll(state.pollDelay);
  }

  async function refreshStatus() {
    state.spotify = await call("/api/spotify/status");
    if (state.spotify && state.spotify.local) state.localSpotify = state.spotify.local;
    return state.spotify;
  }

  async function refreshPlayer(silent) {
    var seq = ++state.playerSeq;
    try {
      var next = await call("/api/spotify/player");
      if (seq !== state.playerSeq) return;
      var pending = state.pendingPlayState;
      if (pending && Date.now() < pending.until && Boolean(next.playing) !== pending.value) {
        // Spotify can report the previous is_playing for a short moment after a write.
        setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 700);
        return;
      }
      if (pending && Boolean(next.playing) === pending.value) state.pendingPlayState = null;
      state.playerError = null;
      state.offline = false;
      if (next && next.device) state.noDevice = false;
      saveLastKnown(next);
      var previousMs = estimatedProgressMs();
      state.player = next;
      syncProgressAnchor(next);
      onTrackChange(next, previousMs);
      scheduleBoundaryCheck(next);
      if (!silent && state.tab === "lecture") render();
      else if (silent) updateNowPlayingDom();
    } catch (err) {
      // Keep last known track/progress on transient Spotify 502s — don't flash the bar to zero.
      if (seq === state.playerSeq) state.playerError = err;
      if (err && err.code !== "spotify_no_device" && err.status !== 401 && err.status !== 403) useLastKnownWhenOffline();
      if (!silent) throw err;
    }
  }

  function playbackSnapshot() {
    var item = (state.player && state.player.item) || null;
    return {
      ok: true,
      playing: !!(state.player && state.player.playing && item),
      progress_ms: estimatedProgressMs(),
      item: item ? {
        id: item.id,
        uri: item.uri,
        name: item.name,
        duration_ms: item.duration_ms,
        artists: item.artists
      } : null
    };
  }

  function emitPlayback() {
    try {
      root.dispatchEvent(new CustomEvent("hq:music-playback", { detail: playbackSnapshot() }));
    } catch (_e) {}
  }

  function updateNowPlayingDom() {
    if (!state.host) return;
    var item = (state.player && state.player.item) || null;
    var playing = !!(state.player && state.player.playing);
    var nowCard = state.host.querySelector(".hqm-now-card");
    if (nowCard) {
      nowCard.classList.toggle("is-live", playing && !!item);
      nowCard.classList.toggle("has-art", !!(item && item.image));
    }
    var title = item ? item.name : "Rien en lecture";
    var artist = item && (item.artists || []).length
      ? item.artists.join(", ")
      : "Choisis une playlist ou une découverte.";
    var album = item && item.album ? item.album : "";
    var artUrl = item && item.image;
    applyTint(artUrl);
    state.host.classList.toggle("hqm-quiz-masked", quizMasking() || blindMasking());
    var nowBackdrop = state.host.querySelector("[data-hqm='hero-backdrop']");
    if (nowBackdrop) {
      if (artUrl) {
        if (nowBackdrop.dataset.coverKey !== String(artUrl)) {
          nowBackdrop.dataset.coverKey = String(artUrl);
          nowBackdrop.src = coverSrc(artUrl, 320);
        }
        nowBackdrop.hidden = false;
      } else {
        nowBackdrop.removeAttribute("src");
        nowBackdrop.dataset.coverKey = "";
        nowBackdrop.hidden = true;
      }
    }

    state.host.querySelectorAll("[data-hqm='track-title']").forEach(function (node) {
      node.textContent = title;
    });
    state.host.querySelectorAll("[data-hqm='track-artist']").forEach(function (node) {
      node.textContent = artist;
    });
    state.host.querySelectorAll("[data-hqm='track-album']").forEach(function (node) {
      node.textContent = album;
    });
    state.host.querySelectorAll("[data-hqm='art']").forEach(function (art) {
      if (artUrl) {
        var heroArt = art.getAttribute("data-hqm-art-size") === "hero";
        applyCover(
          art,
          artUrl,
          heroArt ? 320 : 40,
          heroArt ? "380px" : "(max-width: 700px) 34px, 40px"
        );
        art.hidden = false;
      } else {
        art.removeAttribute("src");
        art.removeAttribute("srcset");
        art.hidden = true;
      }
    });
    state.host.querySelectorAll(".hqm-art-wrap").forEach(function (wrap) {
      wrap.classList.toggle("is-empty", !artUrl);
    });
    var context = (state.player && (state.player.context || state.player.raw_context)) || {};
    var contextUri = context.uri || "";
    var trackUri = (item && item.uri) || "";
    state.host.querySelectorAll("[data-playlist-id]").forEach(function (row) {
      var on = !!contextUri && contextUri === "spotify:playlist:" + row.getAttribute("data-playlist-id");
      row.classList.toggle("is-playing", on);
      var bars = row.querySelector(".hqm-playing-bars");
      if (bars) bars.hidden = !on;
    });
    state.host.querySelectorAll("[data-track-uri]").forEach(function (row) {
      var on = !!trackUri && row.getAttribute("data-track-uri") === trackUri;
      row.classList.toggle("is-playing", on);
      var bars = row.querySelector(".hqm-playing-bars");
      if (bars) bars.hidden = !on;
    });
    state.host.querySelectorAll("[data-hqm='toggle']").forEach(function (button) {
      button.replaceChildren(svgIcon(ICONS[playing ? "pause" : "play"]));
      button.setAttribute("aria-label", playing ? "Mettre en pause" : "Lancer la lecture");
      button.title = playing ? "Mettre en pause" : "Lancer la lecture";
    });
    state.host.querySelectorAll("[data-hqm='shuffle']").forEach(function (button) {
      var on = !!(state.player && state.player.shuffle_state);
      button.classList.toggle("is-on", on);
      button.setAttribute("aria-pressed", on ? "true" : "false");
    });
    state.host.querySelectorAll("[data-hqm='repeat']").forEach(function (button) {
      var mode = (state.player && state.player.repeat_state) || "off";
      button.classList.toggle("is-on", mode !== "off");
      button.setAttribute("aria-pressed", mode !== "off" ? "true" : "false");
      button.setAttribute("aria-label", "Répéter : " +
        (mode === "track" ? "le titre" : mode === "context" ? "la liste" : "désactivé"));
    });
    state.host.querySelectorAll("[data-hqm='progress']").forEach(function (progress) {
      progress.disabled = !item;
    });
    state.host.querySelectorAll("[data-hqm='volume']").forEach(function (volume) {
      if (document.activeElement !== volume) {
        volume.value = String((state.player && state.player.device && state.player.device.volume_percent) || 50);
      }
    });
    state.host.querySelectorAll(".hqm-empty-only").forEach(function (node) {
      node.hidden = !!item;
    });
    state.host.querySelectorAll(".hqm-playing-only").forEach(function (node) {
      node.hidden = !item;
    });
    paintProgress();
    paintDockBadges();
    emitPlayback();
  }

  async function connectSpotify() {
    status("Ouverture de Spotify…");
    var data = await call("/api/spotify/connect");
    if (data.authorize_url) {
      window.location.href = data.authorize_url;
      return;
    }
    throw new Error("URL d'autorisation manquante");
  }

  async function disconnectSpotify() {
    await call("/api/spotify/disconnect", "POST", {});
    state.spotify = await refreshStatus();
    state.player = null;
    render();
    status("Spotify déconnecté.");
  }

  function setOptimisticPlaying(playing) {
    if (!state.player) return;
    state.progressAnchorMs = estimatedProgressMs();
    state.progressAnchorAt = Date.now();
    state.player.playing = !!playing;
    updateNowPlayingDom();
    paintProgress();
  }

  async function togglePlayback() {
    var player = state.player;
    if (!player || !player.item) return playerAction("play");
    var wasPlaying = !!player.playing;
    var wanted = !wasPlaying;
    setOptimisticPlaying(wanted);
    state.pendingPlayState = { value: wanted, until: Date.now() + 3000 };
    try {
      await playerAction(wasPlaying ? "pause" : "play", {
        // The active Connect device is already known when toggling this card.
        auto_device: !(player.device && player.device.is_active)
      }, { skipRefresh: true });
    } catch (err) {
      state.pendingPlayState = null;
      setOptimisticPlaying(wasPlaying);
      throw err;
    }
  }

  async function playerAction(action, extra, options) {
    var opts = options || {};
    var body = Object.assign({ action: action }, deviceExtras(extra));
    try {
      var result = await call("/api/spotify/player", "POST", body);
      if (result && result.device_id && !state.preferredDeviceId) {
        savePreferredDevice(result.device_id);
      }
      if (result && result.device && result.device.name) {
        status("Appareil : " + result.device.name);
      }
      if (!opts.skipRefresh) await refreshPlayer(true);
      if (action === "play" || action === "pause") {
        setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 1200);
      }
      if (state.tab === "lecture") updateNowPlayingDom();
      return result;
    } catch (err) {
      err.message = friendlyPlayerError(err);
      throw err;
    }
  }

  async function loadDevices(opts) {
    var wake = opts && opts.wake ? "?wake=1" : "";
    var data = await call("/api/spotify/devices" + wake);
    state.devices = data.devices || [];
    if (data.local) state.localSpotify = data.local;
    if (!state.preferredDeviceId) {
      var localDev = state.devices.find(function (d) { return d.is_local_candidate && !d.is_restricted; });
      if (localDev) savePreferredDevice(localDev.id);
    }
    return data;
  }

  async function wakeLocalSpotify() {
    status("Réveil Spotify Desktop…");
    var data = await call("/api/spotify/devices/wake", "POST", { wait_s: 3 });
    state.devices = data.devices || [];
    if (data.local) state.localSpotify = data.local;
    var localDev = state.devices.find(function (d) { return d.is_local_candidate && !d.is_restricted; });
    if (localDev) savePreferredDevice(localDev.id);
    render();
    if (localDev) {
      status("PC détecté dans Connect : " + (localDev.name || localDev.id));
    } else if (data.local && data.local.spotify_desktop_running) {
      status("Spotify Desktop tourne, mais Connect ne l'a pas encore listé — attends 2–3 s puis actualise.", true);
    } else {
      status((data.wake && data.wake.message) || "Réveil demandé. Ouvre Spotify si rien n'apparaît.", true);
    }
    return data;
  }

  async function loadPlaylists(reset) {
    if (reset) {
      state.playlistOffset = 0;
      state.playlists = [];
      state.playlistVisible = 12;
    }
    var q = "";
    var input = state.host && state.host.querySelector("[data-hqm='playlist-search']");
    if (input) q = input.value.trim();
    state.playlistsLoading = true;
    if (state.tab === "playlists" && state.shown) render();
    try {
      var data = await call(
        "/api/spotify/playlists?limit=50&offset=" + state.playlistOffset + (q ? "&q=" + encodeURIComponent(q) : "")
      );
      state.playlists = (reset ? [] : state.playlists).concat(data.items || []);
      state.playlistTotal = data.total || state.playlists.length;
      state.playlistOffset = state.playlists.length;
      state.playlistsLoading = false;
    } catch (err) {
      state.playlistsLoading = false;
      if (state.tab === "playlists" && state.shown) render();
      throw err;
    }
  }

  async function openPlaylist(id) {
    var meta = await call("/api/spotify/playlists/" + encodeURIComponent(id));
    state.openPlaylist = meta.playlist;
    state.trackOffset = 0;
    state.tracks = [];
    await loadPlaylistTracks(true);
  }

  async function loadPlaylistTracks(reset) {
    if (!state.openPlaylist) return;
    if (reset) {
      state.trackOffset = 0;
      state.tracks = [];
    }
    var data = await call(
      "/api/spotify/playlists/" +
        encodeURIComponent(state.openPlaylist.id) +
        "/tracks?limit=50&offset=" +
        state.trackOffset
    );
    state.tracks = (reset ? [] : state.tracks).concat(data.items || []);
    state.trackOffset = state.tracks.length;
    state.openPlaylist.tracks_total = data.total;
  }

  async function searchCatalog(append) {
    var input = state.host.querySelector("[data-hqm='catalog-search']");
    var type = state.host.querySelector("[data-hqm='catalog-type']");
    state.catalogQuery = input ? input.value.trim() : "";
    state.catalogType = type ? type.value : "track";
    if (!state.catalogQuery) {
      state.searchResults = null;
      render();
      return;
    }
    var offset = append && state.searchResults ? state.searchResults.next_offset : 0;
    var data = await call("/api/spotify/search?q=" + encodeURIComponent(state.catalogQuery) +
      "&type=" + encodeURIComponent(state.catalogType) + "&offset=" + offset);
    var field = state.catalogType + "s";
    if (append) data[field] = (state.searchResults[field] || []).concat(data[field] || []);
    state.searchResults = data;
    render();
  }

  async function loadMixerData() {
    var results = await Promise.all([
      call("/api/music/presets"),
      call("/api/music/favorites"),
      call("/api/music/session"),
      loadTaste()
    ]);
    state.presets = results[0].presets || [];
    state.favorites = results[1].favorites || { tracks: [], artists: [], playlists: [] };
    state.session = results[2].session || null;
    if (!state.mixerSources.length && state.playlists.length) {
      // leave empty until user adds
    }
  }

  async function generateSession(opts) {
    if (!state.mixerSources.length) throw new Error("Ajoute au moins une playlist source");
    status("Génération de la session…");
    var config = Object.assign({}, state.mixerConfig);
    if (config.seed === "" || config.seed == null) delete config.seed;
    else config.seed = Number(config.seed);
    var data = await call("/api/music/session/generate", "POST", {
      sources: state.mixerSources.map(function (s) {
        return { playlist_id: s.id, name: s.name, weight: Number(s.weight) || 1, energy: Number(s.energy) || 3 };
      }),
      config: config
    });
    state.session = data.session;
    var n = (state.session.tracks || []).length;
    status("Session générée (" + n + " titres)" + (opts && opts.andPlay ? " — démarrage…" : "."));
    render();
    if (opts && opts.andPlay) {
      await playSession();
    }
    return state.session;
  }

  async function saveSessionAsPlaylist() {
    if (!state.session || !(state.session.tracks || []).length) throw new Error("Aucune session");
    var name = "HQ Mixer " + new Date().toISOString().slice(0, 16).replace("T", " ");
    var created = await call("/api/spotify/playlists", "POST", {
      name: name,
      description: "Session générée par Transfert HQ Mixer",
      public: false
    });
    var uris = state.session.tracks.map(function (t) { return t.uri; }).filter(Boolean);
    for (var i = 0; i < uris.length; i += 100) {
      await call("/api/spotify/playlists/" + encodeURIComponent(created.playlist.id) + "/tracks", "POST", {
        op: "add",
        uris: uris.slice(i, i + 100)
      });
    }
    status("Playlist créée : " + name);
    if (created.playlist && created.playlist.uri) {
      await playerAction("play", { context_uri: created.playlist.uri });
    }
  }

  async function playSession() {
    if (!state.session || !(state.session.tracks || []).length) throw new Error("Aucune session");
    var uris = state.session.tracks.map(function (t) { return t.uri; }).filter(Boolean).slice(0, 100);
    await playerAction("play", { uris: uris, auto_device: true });
    var label = "";
    var preferred = state.devices.find(function (d) { return d.id === state.preferredDeviceId; });
    if (preferred) label = preferred.name;
    status("Mixer en lecture" + (label ? " sur " + label : "") + ".");
  }

  function weightShares() {
    var total = state.mixerSources.reduce(function (sum, s) { return sum + (Number(s.weight) || 0); }, 0);
    if (total <= 0) return state.mixerSources.map(function () { return 0; });
    return state.mixerSources.map(function (s) { return Math.round(((Number(s.weight) || 0) / total) * 100); });
  }

  async function loadDiscoveries() {
    var results = await Promise.all([
      call("/api/music/profile"),
      call("/api/music/discoveries"),
      call("/api/music/discovery-query")
    ]);
    state.profile = results[0].profile || {};
    state.discoveries = results[1].discoveries || [];
    state.discoveryQuery = results[2].suggestion || {};
  }

  async function loadRadar(force) {
    var data = await call("/api/music/radar/run", "POST", { force: !!force });
    state.radar = data;
    updateMusicBadge();
    if (state.shown && state.tab === "decouvertes") render();
    if (state.shown && state.tab === "musica") renderGreeting();
    return data;
  }

  function updateMusicBadge() {
    var nav = document.getElementById("nav-musique");
    if (!nav) return;
    var badge = nav.querySelector(".hqm-nav-badge");
    var count = state.radar && state.radar.items ? state.radar.items.length : 0;
    if (!badge && count) {
      badge = el("span", "hqm-nav-badge");
      nav.appendChild(badge);
    }
    if (badge) {
      badge.hidden = !count;
      badge.textContent = String(count);
      badge.setAttribute("aria-label", count + " nouveautés");
    }
  }

  function renderGreeting(node) {
    node = node || (state.host && state.host.querySelector(".hqm-musica-greeting"));
    if (!node) return;
    var current = state.player && state.player.playing && state.player.item;
    var releases = (state.radar && state.radar.items) || [];
    var key = JSON.stringify([current && current.uri, releases.map(function (album) { return album.uri; })]);
    var greeting = state.greeting;
    if (!greeting || greeting.key !== key || Date.now() - greeting.at > 10 * 60 * 1000) {
      var lines = [];
      if (current) lines.push("En lecture · " + current.name + " — " + (current.artists || []).join(", "));
      if (releases.length) lines.push(releases.length + (releases.length === 1 ? " sortie récente" : " sorties récentes") +
        " dans le radar, dont « " + releases[0].name + " ».");
      state.greeting = greeting = { key: key, at: Date.now(), text: lines.join(" ") };
    }
    node.textContent = greeting.text;
    node.hidden = !greeting.text;
  }

  function renderDiscoveryCard(album) {
    var card = el("article", "hqm-album");
    var top = el("div", "hqm-album-top");
    if (album.image) {
      var cover = el("img", "hqm-album-cover");
      cover.alt = "";
      cover.loading = "lazy";
      cover.decoding = "async";
      applyCover(cover, album.image, 84, "(max-width: 390px) 56px, 84px");
      top.appendChild(cover);
    } else {
      top.appendChild(el("div", "hqm-album-cover"));
    }
    var meta = el("div", "hqm-track-meta");
    meta.appendChild(el("strong", "", album.name || "?"));
    var byline = el("span", "");
    (album.artists || []).forEach(function (name, index) {
      if (index) byline.appendChild(document.createTextNode(", "));
      byline.appendChild(btn(name, "hqm-link-btn", function () { openArtist({ name: name }); }));
    });
    if (album.year) byline.appendChild(document.createTextNode(" · " + album.year));
    meta.appendChild(byline);
    top.appendChild(meta);

    var tools = el("div", "hqm-album-tools");
    if (album.uri) {
      tools.appendChild(iconBtn("Lire l’album", "play", function () {
        playerAction("play", { context_uri: album.uri })
          .catch(function (e) { status(friendlyPlayerError(e), true); });
      }));
    }
    tools.appendChild(menuButton("Actions pour " + (album.name || "cet album"), [
      { label: "+ Playlist…", run: function () {
        appendPlaylistPicker(album, "album", card).catch(function (e) { status(e.message, true); });
      } },
      { label: "★ Sauver découverte", run: function () {
        Promise.resolve()
          .then(function () {
            return call("/api/music/discoveries", "POST", { items: [{
              title: album.name,
              artist: (album.artists || [])[0] || "",
              source_url: "https://open.spotify.com/album/" + encodeURIComponent(album.id || "")
            }] });
          })
          .then(function () { status("Découverte sauvée."); })
          .catch(function (e) { status(e.message, true); });
      } },
      { label: "J’aime", run: function () {
        call("/api/music/feedback", "POST", {
          title: album.name, artist: (album.artists || [])[0] || "", liked: true, uri: album.uri
        }).then(function () { status("Avis enregistré."); })
          .catch(function (e) { status(e.message, true); });
      } },
      { label: "Je n’aime pas", run: function () {
        call("/api/music/feedback", "POST", {
          title: album.name, artist: (album.artists || [])[0] || "", liked: false, uri: album.uri
        }).then(function () { status("Avis enregistré."); })
          .catch(function (e) { status(e.message, true); });
      } },
      { label: "Ignorer", danger: true, run: function () {
        updateTaste({ seen: album.uri })
          .then(function () { return call("/api/music/radar"); })
          .then(function (data) {
            state.radar = data;
            updateMusicBadge();
            render();
          })
          .catch(function (e) { status(e.message, true); });
      } }
    ]));
    top.appendChild(tools);
    card.appendChild(top);

    var tracks = el("details", "hqm-album-tracks");
    var summary = document.createElement("summary");
    summary.textContent = "Titres";
    tracks.appendChild(summary);
    var body = el("div", "hqm-album-tracks-body");
    tracks.appendChild(body);
    var loaded = false;
    tracks.addEventListener("toggle", function () {
      if (!tracks.open || loaded) return;
      loaded = true;
      body.textContent = "Chargement…";
      var all = [];
      var offset = 0;
      function next() {
        return call("/api/spotify/albums/" + encodeURIComponent(album.id) + "?offset=" + offset)
          .then(function (data) {
            all = all.concat(data.tracks || []);
            offset = data.next_offset;
            if (offset != null) return next();
            body.replaceChildren();
            all.forEach(function (track) {
              var row = el("div", "hqm-album-track");
              row.appendChild(el("span", "", track.name || "?"));
              if (track.uri) {
                row.appendChild(iconBtn("Lire " + (track.name || "ce titre"), "play", function () {
                  playerAction("play", { uris: [track.uri] })
                    .catch(function (e) { status(friendlyPlayerError(e), true); });
                }));
                row.appendChild(iconBtn("Ajouter « " + (track.name || "ce titre") + " » à la file", "plus", function () {
                  playerAction("queue_add", { uri: track.uri })
                    .then(function () { status("Ajouté à la file."); })
                    .catch(function (e) { status(friendlyPlayerError(e), true); });
                }));
              }
              body.appendChild(row);
            });
            if (!all.length) body.appendChild(el("p", "hqm-muted", "Aucun titre."));
          });
      }
      next().catch(function (err) {
        loaded = false;
        body.textContent = err.message || "Titres indisponibles.";
      });
    });
    card.appendChild(tracks);
    return card;
  }

  function renderRadar(host) {
    var panel = el("section", "hqm-card");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Nouveautés"));
    var items = (state.radar && state.radar.items) || [];
    copy.appendChild(el("p", "hqm-muted",
      items.length ? items.length + (items.length === 1 ? " sortie récente" : " sorties récentes") + " dans le radar." :
        "Les sorties récentes de tes artistes et genres."));
    head.appendChild(copy);
    var actions = el("div", "hqm-row");
    cardButton(actions, "Swipe", function () { return openDeck(); });
    cardButton(actions, "Actualiser", function () {
      state.discoveryLimit = 10;
      return loadRadar(true).then(render);
    });
    head.appendChild(actions);
    panel.appendChild(head);
    var alertLabel = el("label", "hqm-check hqm-alert-toggle");
    var alertBox = document.createElement("input");
    alertBox.type = "checkbox";
    alertBox.checked = !!(state.alerts && state.alerts.releases);
    alertBox.addEventListener("change", function () {
      alertBox.disabled = true;
      call("/api/music/alerts", "POST", { releases: alertBox.checked })
        .then(function (data) {
          state.alerts = data.alerts;
          status(alertBox.checked ? "Alertes de sorties activées (radar vérifié une fois par jour, même Musique fermé)." : "Alertes de sorties coupées.");
        })
        .catch(function (e) { alertBox.checked = !alertBox.checked; status(e.message, true); })
        .finally(function () { alertBox.disabled = false; });
    });
    alertLabel.append(alertBox, " M’avertir des nouvelles sorties (Discord / notification push si activées dans HQ)");
    panel.appendChild(alertLabel);

    var radar = state.radar || {};
    if (radar.code === "spotify_rate_limited") {
      panel.appendChild(el("p", "hqm-muted", "Spotify limite les requêtes. Réessaie après " +
        new Date(radar.retry_at * 1000).toLocaleTimeString("fr-CA") + "."));
    } else if (radar.code === "spotify_unavailable_endpoint") {
      panel.appendChild(el("p", "hqm-muted", "Spotify ne permet pas de vérifier les nouveautés pour ce compte."));
    } else if (!items.length) {
      panel.appendChild(el("p", "hqm-muted", "Aucune sortie récente à afficher pour le moment."));
    } else {
      var limit = state.discoveryLimit || 10;
      var shown = items.slice(0, limit);
      var grid = el("div", "hqm-album-grid");
      shown.forEach(function (album) {
        grid.appendChild(renderDiscoveryCard(album));
      });
      panel.appendChild(grid);
      if (items.length > shown.length) {
        panel.appendChild(btn("Voir les " + (items.length - shown.length) + " autres", "hqm-btn secondary hqm-load-more", function () {
          state.discoveryLimit = limit + 10;
          render();
        }));
      }
    }
    host.appendChild(panel);
  }

  /* A quiet reminder: the Quiz tab wears a dot while today's daily challenge is still unplayed. */
  function dailyPending() {
    var d = state.djShow && state.djShow.daily;
    return !!(d && d.done_today === false);
  }

  function dailyDot() {
    var dot = el("span", "hqm-tab-dot");
    dot.setAttribute("role", "img");
    dot.setAttribute("aria-label", "Défi du jour disponible");
    dot.title = "Défi du jour disponible";
    return dot;
  }

  function paintDailyDot() {
    var tab = state.host && state.host.querySelector("#hqm-tab-quiz");
    if (!tab) return;
    var dot = tab.querySelector(".hqm-tab-dot");
    if (dailyPending() && !dot) tab.appendChild(dailyDot());
    else if (!dailyPending() && dot) dot.remove();
  }

  function renderTabs() {
    var tabs = el("div", "hqm-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Sections Musique");
    [
      ["lecture", "Lecture", "play"],
      ["playlists", "Playlists", "list"],
      ["mixer", "Mixer", "sliders"],
      ["decouvertes", "Découvertes", "spark"],
      ["musica", "Musica", "chat"],
      ["journal", "Journal", "chart"],
      ["quiz", "Quiz", "quiz"],
      ["studio", "Studio IA", "studio"]
    ].forEach(function (pair) {
      var count = pair[0] === "decouvertes" && state.radar ? (state.radar.items || []).length : 0;
      var tab = btn("", "hqm-tab", function () { setTab(pair[0]); });
      tab.setAttribute("role", "tab");
      tab.id = "hqm-tab-" + pair[0];
      tab.setAttribute("aria-controls", "hqm-panel-" + pair[0]);
      tab.setAttribute("aria-selected", state.tab === pair[0] ? "true" : "false");
      tab.tabIndex = state.tab === pair[0] ? 0 : -1;
      var tabIcon = svgIcon(ICONS[pair[2]], 16);
      tabIcon.classList.add("hqm-tab-ico");
      tab.appendChild(tabIcon);
      tab.appendChild(el("span", "", pair[1]));
      if (count) tab.appendChild(el("span", "hqm-tab-count", String(count)));
      if (pair[0] === "quiz" && dailyPending()) tab.appendChild(dailyDot());
      tabs.appendChild(tab);
    });
    tabs.addEventListener("keydown", function (event) {
      var list = Array.prototype.slice.call(tabs.querySelectorAll(".hqm-tab"));
      var index = list.indexOf(document.activeElement);
      if (index < 0) return;
      var next = index;
      if (event.key === "ArrowRight") next = (index + 1) % list.length;
      else if (event.key === "ArrowLeft") next = (index - 1 + list.length) % list.length;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = list.length - 1;
      else return;
      event.preventDefault();
      list[next].focus();
      list[next].click();
    });
    requestAnimationFrame(function () {
      var active = tabs.querySelector('[aria-selected="true"]');
      if (!active) return;
      var ar = active.getBoundingClientRect();
      var tr = tabs.getBoundingClientRect();
      tabs.scrollLeft = Math.max(0, tabs.scrollLeft + (ar.left - tr.left) - (tabs.clientWidth - ar.width) / 2);
    });
    return tabs;
  }

  function renderDock() {
    var item = (state.player && state.player.item) || null;
    var playing = !!(state.player && state.player.playing);
    var dock = el("div", "hqm-dock");
    var open = btn("", "hqm-dock-open", function () { setTab("lecture"); });
    open.setAttribute("aria-label", "Ouvrir le lecteur");
    open.title = "Ouvrir le lecteur";
    var artWrap = el("div", "hqm-dock-art hqm-art-wrap" + (item && item.image ? "" : " is-empty"));
    var art = el("img", "hqm-art");
    art.setAttribute("data-hqm", "art");
    art.setAttribute("data-hqm-art-size", "dock");
    art.alt = "";
    if (item && item.image) applyCover(art, item.image, 40, "(max-width: 700px) 34px, 40px");
    else art.hidden = true;
    artWrap.appendChild(art);
    artWrap.appendChild(el("span", "hqm-art-note", "♪"));
    open.appendChild(artWrap);
    var meta = el("div", "hqm-track-meta");
    var title = el("strong", "");
    title.setAttribute("data-hqm", "track-title");
    var artist = el("span", "");
    artist.setAttribute("data-hqm", "track-artist");
    meta.append(title, artist);
    open.appendChild(meta);
    dock.appendChild(open);

    var controls = el("div", "hqm-dock-controls");
    controls.appendChild(iconBtn("Précédent", "previous", function () {
      playerAction("previous").catch(function (e) { status(friendlyPlayerError(e), true); });
    }, "hqm-dock-prev"));
    var toggle = iconBtn(playing ? "Mettre en pause" : "Lancer la lecture", playing ? "pause" : "play", function () {
      togglePlayback()
        .catch(function (e) { status(friendlyPlayerError(e), true); });
    }, "hqm-dock-toggle");
    toggle.setAttribute("data-hqm", "toggle");
    controls.appendChild(toggle);
    controls.appendChild(iconBtn("Suivant", "next", function () {
      playerAction("next").catch(function (e) { status(friendlyPlayerError(e), true); });
    }, "hqm-dock-next"));
    var sleepChip = btn("", "hqm-dock-chip hqm-sleep-chip", function () { cancelSleep(false); });
    sleepChip.setAttribute("data-hqm", "sleep-chip");
    sleepChip.hidden = true;
    controls.insertBefore(sleepChip, controls.firstChild);
    var djChip = el("span", "hqm-dock-chip hqm-dj-chip", "DJ");
    djChip.setAttribute("data-hqm", "dj-chip");
    djChip.title = "DJ Musica active";
    djChip.hidden = true;
    controls.insertBefore(djChip, controls.firstChild);
    dock.appendChild(controls);
    var djLine = el("p", "hqm-dock-dj");
    djLine.setAttribute("data-hqm", "dj-line");
    djLine.setAttribute("aria-live", "polite");
    djLine.hidden = true;
    dock.appendChild(djLine);

    var progress = document.createElement("input");
    progress.type = "range";
    progress.className = "hqm-dock-progress";
    progress.setAttribute("data-hqm", "dock-progress");
    progress.setAttribute("aria-label", "Position dans le morceau");
    progress.min = "0";
    progress.value = String(estimatedProgressMs());
    progress.addEventListener("pointerdown", function () { state.seeking = true; });
    progress.addEventListener("pointerup", function () { state.seeking = false; });
    progress.addEventListener("change", function () {
      var ms = Number(progress.value) || 0;
      state.seeking = false;
      state.progressAnchorMs = ms;
      state.progressAnchorAt = Date.now();
      if (state.player) state.player.progress_ms = ms;
      paintProgress();
      playerAction("seek", { position_ms: ms }).catch(function (e) { status(friendlyPlayerError(e), true); });
    });
    dock.appendChild(progress);
    return dock;
  }

  function renderAccountChip() {
    if (!state.spotify || !state.spotify.connected) {
      return btn("Connecter Spotify", "hqm-btn", function () {
        connectSpotify().catch(function (e) { status(e.message, true); });
      });
    }
    var account = el("details", "hqm-account");
    var summary = document.createElement("summary");
    summary.appendChild(el("span", "hqm-account-dot"));
    summary.appendChild(el("span", "", state.spotify.display_name || "Spotify"));
    summary.appendChild(el("span", "hqm-account-plan", state.spotify.product || "connecté"));
    account.appendChild(summary);
    var panel = el("div", "hqm-account-panel");
    panel.appendChild(el("p", "hqm-muted",
      (state.spotify.product ? "Offre " + state.spotify.product : "") +
      (state.spotify.email ? " · " + state.spotify.email : "")));
    panel.appendChild(btn("Appareils", "hqm-btn secondary", function () {
      setTab("lecture");
      requestAnimationFrame(function () {
        var devices = state.host && state.host.querySelector(".hqm-devices");
        if (devices) devices.open = true;
      });
    }));
    panel.appendChild(btn("Reconnecter", "hqm-btn secondary", function () {
      connectSpotify().catch(function (e) { status(e.message, true); });
    }));
    panel.appendChild(btn("Déconnecter", "hqm-btn secondary", function () {
      disconnectSpotify().catch(function (e) { status(e.message, true); });
    }));
    account.appendChild(panel);
    return account;
  }

  function revealMusicaComposer() {
    if (window.innerWidth >= 700) return;
    var topbar = state.host && state.host.querySelector(".hqm-topbar");
    if (!topbar) return;
    if (isChatPaneWidth()) {
      var stickyTop = parseFloat(getComputedStyle(topbar).top) || 0;
      if (!state.topbarTop || window.scrollY === 0) {
        state.topbarTop = Math.round(topbar.getBoundingClientRect().top + window.scrollY);
      }
      var target = state.topbarTop - stickyTop;
      if (Math.abs(window.scrollY - target) > 2) window.scrollTo(0, target);
      return;
    }
    var composer = state.host && state.host.querySelector(".hqm-chat-composer");
    var nav = document.querySelector(".bottom-nav");
    if (!composer || !nav) return;
    var overlap = composer.getBoundingClientRect().bottom - (nav.getBoundingClientRect().top - 8);
    if (overlap <= 0) return;
    var topbarTop = topbar.getBoundingClientRect().top;
    if (topbarTop > 0) window.scrollTo({ top: topbarTop + window.scrollY, behavior: "smooth" });
    else window.scrollBy({ top: overlap, behavior: "smooth" });
  }

  function setTab(tab) {
    var previousTab = state.tab;
    if (tab !== previousTab) {
      state.tabScroll[previousTab] = window.scrollY;
      state.pendingTabScroll = state.tabScroll[tab] || 0;
    }
    if (tab !== "musica" && state.micCancel) state.micCancel();
    if (tab !== "musica") document.body.classList.remove("hqm-keyboard-open");
    state.tab = tab;
    stopStudioPoll();
    render();
    try {
      root.dispatchEvent(new CustomEvent("hq:music-tab", { detail: { tab: tab } }));
    } catch (_e) {}
    startPoll();
    if (tab === "studio") {
      refreshStudio();
      state.studioTimer = setInterval(refreshStudio, 5000);
    }
    if (tab === "playlists" && state.spotify && state.spotify.connected && !state.playlists.length) {
      loadPlaylists(true).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "mixer") {
      Promise.all([
        state.playlists.length ? Promise.resolve() : loadPlaylists(true).catch(function () {}),
        loadMixerData(),
        loadMood()
      ]).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "decouvertes") {
      Promise.all([
        loadDiscoveries(),
        call("/api/music/alerts").then(function (data) { state.alerts = data.alerts; }).catch(function () {})
      ]).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "lecture" && state.spotify && state.spotify.connected) {
      loadDjShow().then(paintDjCard).catch(function () {});
    }
    if (tab !== "lecture" && tab !== "quiz" && state.spotify && state.spotify.connected && !state.djShow) {
      loadDjShow().then(paintStrip).catch(function () {});
    }
    if (tab === "journal") {
      var rc = ensureRecap();
      if (!rc.wrapped && !rc.loading.wrapped) loadWrapped();
      if (!rc.today) loadOnThisDay();
    }
    if (tab === "journal") {
      loadJournal(state.journal && state.journal.month).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "quiz") {
      var quizLoads = [call("/api/music/quiz").then(function (data) {
        var quiz = ensureQuiz();
        quiz.best = data.best || 0;
        if (data.game && !data.game.done && !quiz.game) quiz.game = data.game;
      })];
      if (!state.playlists.length && state.spotify && state.spotify.connected) quizLoads.push(loadPlaylists(true).catch(function () {}));
      if (state.spotify && state.spotify.connected) quizLoads.push(loadDjShow().catch(function () {}));
      if (state.spotify && state.spotify.connected) quizLoads.push(loadHall());
      Promise.all(quizLoads).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "musica") {
      revealMusicaComposer();
      var requests = [loadMusicaThread()];
      if (state.spotify && state.spotify.connected) requests.push(refreshPlayer(true));
      Promise.all(requests).then(function () {
        if (state.tab === "musica" && !state.musicaBusy) render();
        if (state.tab === "musica") revealMusicaComposer();
      }).catch(function (e) { status(e.message, true); });
    }
  }

  async function loadMusicaThread() {
    state.musicaThreadLoading = true;
    if (state.tab === "musica" && state.shown) render();
    try {
      var results = await Promise.all([call("/api/musica/thread"), loadTaste()]);
      var data = results[0];
      state.musicaThread = data.messages || [];
      state.musicaLoaded = true;
      return data;
    } catch (err) {
      state.musicaLoaded = true;
      throw err;
    } finally {
      state.musicaThreadLoading = false;
    }
  }

  async function sendMusica(text, context) {
    var message = String(text || "").trim();
    if (!message) return;
    if (state.musicaBusy) return;
    state.musicaBusy = true;
    state.musicaError = null;
    state.musicaDraft = message;
    state.musicaContext = context;
    render();
    try {
      var data = await call("/api/musica/chat", "POST", { message: message, context: context });
      state.musicaThread = data.thread || state.musicaThread;
      state.musicaDraft = "";
      state.musicaContext = undefined;
      state.voiceLanguage = speechLanguage(message);
      if (state.musicaSpeaks) speakMusica(data.reply).catch(function (err) { status(err.message, true); });
      return data;
    } catch (err) {
      state.musicaError = err.message || "Musica indisponible";
      throw err;
    } finally {
      state.musicaBusy = false;
      render();
    }
  }

  function speechLanguage(text) {
    return /\b(play|pause|resume|what|skip|find|show|search|please|next|volume up|volume down)\b/i.test(text)
      && !/\b(joue|cherche|reprends|suivant|quoi|titre|morceau|quelle|mets)\b/i.test(text) ? "en" : "fr";
  }

  function browserSpeech(text, language) {
    return new Promise(function (resolve, reject) {
      if (!root.speechSynthesis || !root.SpeechSynthesisUtterance) {
        reject(new Error("Voix navigateur indisponible."));
        return;
      }
      var utterance = new root.SpeechSynthesisUtterance(text);
      var voices = root.speechSynthesis.getVoices();
      var matches = voices.filter(function (voice) { return voice.lang.toLowerCase().startsWith(language); });
      var neural = /Sylvie|Denise|Eloise|Amélie|Chloé|Hortense|Julie|Natural|Online|Google/i;
      utterance.lang = language === "en" ? "en-US" : "fr-CA";
      utterance.voice = matches.find(function (voice) {
        return voice.lang === utterance.lang && neural.test(voice.name);
      }) || matches.find(function (voice) { return neural.test(voice.name); })
        || matches.find(function (voice) { return voice.lang === utterance.lang; }) || matches[0] || null;
      var timer = setTimeout(function () {
        root.speechSynthesis.cancel();
        reject(new Error("Délai de lecture vocale dépassé."));
      }, 60000);
      utterance.onend = function () { clearTimeout(timer); resolve(); };
      utterance.onerror = function () { clearTimeout(timer); reject(new Error("Lecture vocale interrompue.")); };
      root.speechSynthesis.speak(utterance);
    });
  }

  /* One shared <audio> element, unlocked by the first tap/click: browsers (always on iPhone) refuse to start
     sound that is not triggered by a gesture, and DJ drops start on their own, seconds after the click. */
  var SILENT_MP3 = "data:audio/mpeg;base64,SUQzBAAAAAAAIlRTU0UAAAAOAAADTGF2ZjYxLjcuMTAwAAAAAAAAAAAAAAD/83DAAAAAAAAAAAAASW5mbwAAAA8AAAAIAAAD+gBHR0dHR0dHR0dHR0diYmJiYmJiYmJiYmJ8fHx8fHx8fHx8fHx8lpaWlpaWlpaWlpaWsbGxsbGxsbGxsbGxscvLy8vLy8vLy8vLy+Xl5eXl5eXl5eXl5eX///////////////8AAAAATGF2YzYxLjE5AAAAAAAAAAAAAAAAJALUAAAAAAAAA/rLK5WzAAAAAAAAAAAAAAAAAP/zQMQAAAADSAAAAABMQU1FMy4xMDBVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxFsAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVTEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NAxKQAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80LEowAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVX/80DEpAAAA0gAAAAAVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQsSjAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVUxBTUUzLjEwMFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVf/zQMSkAAADSAAAAABVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV//NCxKMAAANIAAAAAFVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

  function speechAudio() {
    if (!state.audioEl) {
      state.audioEl = new Audio();
      state.audioEl.preload = "auto";
      state.audioEl.setAttribute("playsinline", "");
    }
    return state.audioEl;
  }

  function unlockAudio() {
    var pending = state.pendingDrops;
    if (pending) {
      state.pendingDrops = null;
      playDrops(pending.drops, pending.text, false).catch(function () {});
      return;
    }
    if (state.audioUnlocked || state.audioUnlocking || state.speakingMusica) return;
    var audio = speechAudio();
    state.audioUnlocking = true;
    audio.muted = true;
    audio.src = SILENT_MP3;
    var started = audio.play();
    var done = function (ok) {
      state.audioUnlocking = false;
      audio.muted = false;
      if (ok) state.audioUnlocked = true;
    };
    if (started && started.then) started.then(function () { audio.pause(); done(true); }).catch(function () { done(false); });
    else done(true);
  }

  function playSpeech(url) {
    return new Promise(function (resolve, reject) {
      var audio = speechAudio();
      var timer = setTimeout(function () {
        audio.pause();
        reject(new Error("Délai de lecture vocale dépassé."));
      }, 60000);
      function fail(error) {
        clearTimeout(timer);
        audio.onended = audio.onerror = null;
        reject(error);
      }
      audio.onended = function () { clearTimeout(timer); audio.onended = audio.onerror = null; resolve(); };
      audio.onerror = function () { fail(new Error("Audio Musica indisponible.")); };
      audio.muted = false;
      audio.src = url;
      var started = audio.play();
      if (started && started.catch) started.catch(fail);
    });
  }

  async function speakMusica(reply) {
    if (state.speakingMusica || !reply) return;
    var text = String(reply).replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/<[^>]+>|[`*_#]/g, "").trim();
    if (!text) return;
    state.speakingMusica = true;
    var request = state.request;
    var language = state.voiceLanguage || "fr";
    var ducked = null;
    function volume(device, level) {
      return call("/api/spotify/player", "POST", {
        action: "volume", device_id: device.id, volume_percent: level, auto_device: false
      }, request);
    }
    try {
      var voice = await call("/api/musica/speak", "POST", { text: text, language: language }).catch(function () { return null; });
      var player = state.spotify && state.spotify.connected
        ? await call("/api/spotify/player").catch(function () { return null; }) : null;
      var device = player && player.playing && player.device;
      if (device && device.id && Number.isFinite(device.volume_percent) && device.volume_percent > 10) {
        ducked = device;
        await volume(device, Math.max(5, Math.round(device.volume_percent * 0.35))).catch(function () {});
      }
      if (voice && voice.audio_url) {
        await playSpeech(voice.audio_url).catch(function () { return browserSpeech(text, language); });
      } else {
        await browserSpeech(text, language);
      }
    } finally {
      state.speakingMusica = false;
      if (ducked) {
        await volume(ducked, ducked.volume_percent).catch(function () { return volume(ducked, ducked.volume_percent); });
      }
    }
  }

  async function voiceIntent(text) {
    var key = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[’']/g, " ").replace(/[.!?]+$/, "").trim();
    var djMatch = key.match(/^(?:hey |ok )?d\.? ?j\.?[ ,:]+(.+)$/);
    if (djMatch) {
      var wish = djMatch[1].trim();
      if (/^(stop|arrete|coupe)/.test(wish)) { state.djShow = await call("/api/musica/dj/stop", "POST", {}); render(); return; }
      if (/^(lance|demarre|go|commence)/.test(wish) && !(state.djShow && state.djShow.active)) { await djStart({ show: "dj" }); render(); return; }
      if (/^(un )?tournoi/.test(wish)) { await djTournament(false); render(); return; }
      if (/^(un )?duel/.test(wish)) { await djDuel(); render(); return; }
      var votes = { a: "a", b: "b", premier: "a", "1": "a", "1er": "a", un: "a", deuxieme: "b", second: "b", "2": "b", "2eme": "b", deux: "b" };
      var voteWord = wish.replace(/^(je choisis |je prends |je vote |c est )?(le |la )?/, "").trim().split(/\s+/)[0];
      if (state.djShow && state.djShow.duels && state.djShow.duels.current && !state.djShow.duels.current.vote && votes[voteWord]) {
        await djVote(votes[voteWord]);
        render();
        return;
      }
      await djAsk(text.replace(/^\s*(?:hey |ok )?d\.? ?j\.?[ ,:]+/i, ""));
      render();
      return;
    }
    var command = {
      suivant: "next", next: "next", pause: "pause", reprends: "play", resume: "play"
    }[key];
    if (command) {
      await playerAction(command);
      return;
    }
    if (["plus fort", "moins fort", "volume up", "volume down"].includes(key)) {
      var player = await call("/api/spotify/player");
      var device = player.device;
      if (!device || !Number.isFinite(device.volume_percent)) throw new Error("Volume Spotify indisponible.");
      var delta = key === "plus fort" || key === "volume up" ? 10 : -10;
      await playerAction("volume", { device_id: device.id, volume_percent: device.volume_percent + delta, auto_device: false });
      return;
    }
    if (["c est quoi ce morceau", "what is this song"].includes(key)) {
      var data = await call("/api/spotify/player");
      var track = data.item;
      var reply = track ? track.name + " · " + (track.artists || []).join(", ") : "Aucun morceau Spotify en cours.";
      state.musicaThread = state.musicaThread.concat([{ role: "assistant", text: reply,
        cards: track ? [Object.assign({ kind: "track" }, track)] : [] }]);
      render();
      if (state.musicaSpeaks) await speakMusica(reply);
      return;
    }
    await sendMusica(text);
  }

  function pushToTalk(composer, input) {
    var Recognition = root.SpeechRecognition || root.webkitSpeechRecognition;
    if (!Recognition) {
      composer.title = "La dictée Musica est indisponible dans ce navigateur.";
      return;
    }
    var microphone = btn("Micro", "hqm-btn secondary", function () {});
    microphone.setAttribute("aria-label", "Maintenir pour parler à Musica");
    microphone.setAttribute("aria-pressed", "false");
    microphone.title = "Maintiens pour parler, relâche pour envoyer.";
    microphone.disabled = !!state.musicaBusy;
    var recognizer = null;
    var held = false;
    var cancelled = false;
    var draft = "";
    var transcript = "";
    function complete() {
      state.micCancel = null;
      microphone.setAttribute("aria-pressed", "false");
      microphone.textContent = "Micro";
      input.value = draft;
      if (!cancelled && transcript && state.shown && state.tab === "musica") {
        state.voiceLanguage = speechLanguage(transcript);
        voiceIntent(transcript).catch(function (err) { status(err.message, true); });
      }
    }
    function begin() {
      if (recognizer || held || microphone.disabled) return;
      draft = input.value;
      transcript = "";
      cancelled = false;
      held = true;
      state.micCancel = function () { finish(true); };
      microphone.setAttribute("aria-pressed", "true");
      microphone.textContent = "Écoute…";
      startRecognition(speechLanguage(draft) === "en" || state.voiceLanguage === "en" ? "en-US" : "fr-FR");
    }
    function startRecognition(language) {
      var noMatch = false;
      recognizer = new Recognition();
      recognizer.lang = language;
      recognizer.interimResults = true;
      recognizer.onstart = function () {
        if (cancelled) recognizer.abort();
        else if (!held) recognizer.stop();
      };
      recognizer.onresult = function (event) {
        transcript = Array.from(event.results).map(function (result) { return result[0].transcript; }).join(" ").trim();
        input.value = transcript;
      };
      recognizer.onnomatch = function () { noMatch = true; };
      recognizer.onerror = function (event) {
        if (event.error === "no-speech") noMatch = true;
        else {
          cancelled = true;
          held = false;
          if (event.error !== "aborted") status("Micro indisponible · " + event.error, true);
        }
      };
      recognizer.onend = function () {
        recognizer = null;
        if (held && noMatch && !transcript && language === "fr-FR") startRecognition("en-US");
        else if (held) microphone.textContent = "Relâcher";
        else complete();
      };
      try { recognizer.start(); }
      catch (err) {
        recognizer = null;
        held = false;
        cancelled = true;
        complete();
        status(err.message, true);
      }
    }
    function finish(abort) {
      if (!held && !recognizer) return;
      held = false;
      cancelled = cancelled || abort;
      if (!recognizer) { complete(); return; }
      try { if (abort) recognizer.abort(); else recognizer.stop(); }
      catch (_e) {}
    }
    microphone.addEventListener("pointerdown", function (event) {
      if (event.button !== 0) return;
      microphone.setPointerCapture(event.pointerId);
      begin();
    });
    microphone.addEventListener("pointerup", function () { finish(false); });
    microphone.addEventListener("pointercancel", function () { finish(true); });
    microphone.addEventListener("lostpointercapture", function () { if (held) finish(true); });
    microphone.addEventListener("keydown", function (event) {
      if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault(); begin(); }
      if (event.key === "Escape") finish(true);
    });
    microphone.addEventListener("keyup", function (event) {
      if (event.key === " " || event.key === "Enter") { event.preventDefault(); finish(false); }
    });
    composer.appendChild(microphone);
  }

  function cardButton(row, label, task) {
    var button = btn(label, "hqm-btn secondary", async function () {
      button.disabled = true;
      try { await task(); }
      catch (err) { status(friendlyPlayerError(err), true); }
      finally { button.disabled = false; }
    });
    row.appendChild(button);
    return button;
  }

  var ICONS = {
    play: ["M8 5v14l11-7z"],
    pause: ["M7 5h4v14H7zm6 0h4v14h-4z"],
    previous: ["M6 5h2v14H6zM20 5v14L9 12z"],
    next: ["M16 5h2v14h-2zM4 5v14l11-7z"],
    shuffle: ["M17 3h4v4h-2V5.4l-4.3 4.3-1.4-1.4L17.6 5H17zM3 5h4.2l10 10H21v2h-4.2l-10-10H3zM3 17h4.2l3.3-3.3 1.4 1.4L8.2 19H3z"],
    repeat: ["M7 7h9V4l4 4-4 4V9H7a3 3 0 0 0-3 3H2a5 5 0 0 1 5-5zm10 10H8v3l-4-4 4-4v3h9a3 3 0 0 0 3-3h2a5 5 0 0 1-5 5z"],
    more: ["M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"],
    volume: ["M4 9v6h4l5 4V5L8 9H4z"],
    search: ["M10 4a6 6 0 1 0 3.5 10.9l4.3 4.3 1.4-1.4-4.3-4.3A6 6 0 0 0 10 4zm0 2a4 4 0 1 1 0 8 4 4 0 0 1 0-8z"],
    plus: ["M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"],
    list: ["M4 6h16v2H4zM4 11h16v2H4zM4 16h11v2H4z"],
    sliders: ["M4 6h7v2H4zm9 0h7v2h-7zM4 11h3v2H4zm5 0h11v2H9zM4 16h11v2H4zm13 0h3v2h-3z"],
    spark: ["M12 3.5l1.7 5.1 5.2 1.7-5.2 1.7-1.7 5.1-1.7-5.1L5.1 10.3l5.2-1.7zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z"],
    chat: ["M4 5h16v11H9l-5 4z"],
    studio: ["M5 19l2-5 8.5-8.5 3 3L10 17zM4 21h16v-1.5H4z"],
    close: ["M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4L12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z"],
    heart: ["M12 20.3l-1.4-1.3C5.4 14.4 2 11.3 2 7.5 2 4.4 4.4 2 7.5 2c1.7 0 3.4.8 4.5 2.1C13.1 2.8 14.8 2 16.5 2 19.6 2 22 4.4 22 7.5c0 3.8-3.4 6.9-8.6 11.5z"],
    chart: ["M4 19h16v2H4zM5 10h3v7H5zm5.5-5h3v12h-3zM16 13h3v4h-3z"],
    mic: ["M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9z"],
    sun: ["M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z"],
    focus: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm0 3a5 5 0 1 0 0 10 5 5 0 0 0 0-10zm0 2a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"],
    replay: ["M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"],
    star: ["M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z"],
    quiz: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 16h-2v-2h2zm2.1-7.7-.9.9c-.7.7-1.2 1.3-1.2 2.8h-2v-.5c0-1.1.5-2.1 1.2-2.8l1.2-1.3c.4-.3.6-.8.6-1.4a2 2 0 0 0-4 0H8a4 4 0 1 1 8 0c0 .9-.4 1.6-.9 2.3z"]
  };

  function svgIcon(paths, size) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", String(size || 20));
    svg.setAttribute("height", String(size || 20));
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    (paths || ICONS.play).forEach(function (d) {
      var path = document.createElementNS(ns, "path");
      path.setAttribute("d", d);
      path.setAttribute("fill", "currentColor");
      svg.appendChild(path);
    });
    return svg;
  }

  function iconBtn(label, icon, onClick, extraClass) {
    var button = btn("", "hqm-icon-btn" + (extraClass ? " " + extraClass : ""), onClick);
    button.appendChild(svgIcon(ICONS[icon] || ICONS.play));
    button.setAttribute("aria-label", label);
    button.title = label;
    return button;
  }

  function toggleButton(label, icon, onClick) {
    var button = btn("", "hqm-toggle", onClick);
    button.appendChild(svgIcon(ICONS[icon]));
    button.appendChild(el("span", "", label));
    button.setAttribute("aria-pressed", "false");
    return button;
  }

  function playingBars() {
    var bars = el("span", "hqm-playing-bars");
    bars.setAttribute("aria-label", "En lecture");
    bars.hidden = true;
    bars.append(el("i"), el("i"), el("i"));
    return bars;
  }

  function skeletonDetail() {
    var box = el("div", "hqm-skel-detail");
    box.appendChild(el("span", "hqm-skel-line w40"));
    box.appendChild(el("span", "hqm-skel-line w70"));
    box.appendChild(el("span", "hqm-skel-block"));
    return box;
  }

  function menuButton(label, items, extraClass) {
    var details = el("details", "hqm-menu" + (extraClass ? " " + extraClass : ""));
    var summary = document.createElement("summary");
    summary.setAttribute("aria-label", label);
    summary.title = label;
    summary.appendChild(svgIcon(ICONS.more));
    details.appendChild(summary);
    var backdrop = btn("", "hqm-sheet-backdrop", function () { details.open = false; });
    backdrop.setAttribute("aria-label", "Fermer le menu");
    details.appendChild(backdrop);
    var panel = el("div", "hqm-menu-panel");
    (items || []).filter(Boolean).forEach(function (item) {
      var button = btn(item.label, "hqm-menu-item", function () {
        details.open = false;
        item.run();
      });
      if (item.danger) button.classList.add("is-danger");
      panel.appendChild(button);
    });
    panel.appendChild(btn("Annuler", "hqm-menu-item hqm-sheet-close", function () { details.open = false; }));
    details.appendChild(panel);
    details.addEventListener("toggle", function () {
      if (window.innerWidth > 700) return;
      if (!details.open) {
        summary.focus({ preventScroll: true });
        return;
      }
      var first = panel.querySelector("button");
      if (first) first.focus({ preventScroll: true });
    });
    return details;
  }

  function disclosureCard(title, className) {
    var details = el("details", "hqm-card hqm-disclosure" + (className ? " " + className : ""));
    var summary = document.createElement("summary");
    summary.appendChild(el("span", "", title));
    details.appendChild(summary);
    var body = el("div", "hqm-disclosure-body");
    details.appendChild(body);
    return { root: details, body: body, summary: summary };
  }

  function rangeField(key, label, min, max, step, format, hint) {
    var field = el("div", "hqm-field hqm-range-field");
    var head = el("div", "hqm-range-head");
    head.appendChild(el("label", "hqm-label", label));
    var output = el("output", "hqm-range-value", format(state.mixerConfig[key]));
    head.appendChild(output);
    field.appendChild(head);
    var input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(state.mixerConfig[key]);
    input.setAttribute("aria-label", label);
    input.addEventListener("input", function () {
      state.mixerConfig[key] = Number(input.value);
      output.textContent = format(state.mixerConfig[key]);
    });
    field.appendChild(input);
    if (hint) field.appendChild(el("p", "hqm-muted hqm-hint", hint));
    return field;
  }

  async function fetchAlbumTracks(id) {
    var tracks = [];
    var offset = 0;
    do {
      var data = await call("/api/spotify/albums/" + encodeURIComponent(id) + "?offset=" + offset);
      tracks = tracks.concat((data.tracks || []).map(function (track) { return track.uri; }).filter(Boolean));
      offset = data.next_offset;
    } while (offset != null);
    return tracks;
  }

  async function appendPlaylistPicker(item, kind, anchor) {
    var existing = anchor.querySelector(".hqm-inline-picker");
    if (existing) {
      existing.remove();
      return;
    }
    var box = el("div", "hqm-inline-picker");
    box.appendChild(el("p", "hqm-muted", "Ajouter « " + (item.name || "ce titre") + " » à…"));
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Playlist de destination");
    var playlists = state.playlists.length ? state.playlists : [];
    if (!playlists.length) {
      try {
        playlists = (await call("/api/spotify/playlists?limit=50")).items || [];
      } catch (err) {
        status(err.message, true);
        return;
      }
    }
    if (!playlists.length) {
      box.appendChild(el("p", "hqm-muted", "Aucune playlist disponible."));
      anchor.appendChild(box);
      return;
    }
    playlists.forEach(function (playlist) {
      var option = document.createElement("option");
      option.value = playlist.id;
      option.textContent = playlist.name;
      select.appendChild(option);
    });
    box.appendChild(select);
    var row = el("div", "hqm-row");
    row.appendChild(btn("Ajouter", "hqm-btn", async function () {
      try {
        var uris = kind === "track" ? [item.uri] : await fetchAlbumTracks(item.id);
        for (var i = 0; i < uris.length; i += 100) {
          await call("/api/spotify/playlists/" + encodeURIComponent(select.value) + "/tracks", "POST", {
            uris: uris.slice(i, i + 100)
          });
        }
        box.replaceChildren(el("p", "hqm-muted", "Ajouté à la playlist."));
      } catch (err) {
        status(err.message, true);
      }
    }));
    row.appendChild(btn("Annuler", "hqm-btn secondary", function () { box.remove(); }));
    box.appendChild(row);
    anchor.appendChild(box);
    select.focus();
  }

  function renderMusicCard(item) {
    var card = el("article", "hqm-result-card");
    if (item.name) card.setAttribute("aria-label", item.name);
    var media = el("div", "hqm-media-row");
    if (item.image) {
      var cover = el("img", "hqm-thumb");
      cover.alt = "";
      cover.loading = "lazy";
      applyCover(cover, item.image, 48);
      media.appendChild(cover);
    }
    var meta = el("div", "hqm-track-meta");
    meta.appendChild(el("strong", "", item.name || "Spotify"));
    var details = (item.artists || []).concat([item.album, item.year]).filter(Boolean).join(" · ");
    if (details) meta.appendChild(el("span", "hqm-muted", details));
    if (item.why || item.reason) meta.appendChild(el("span", "hqm-reason", item.why || item.reason));
    media.appendChild(meta);
    card.appendChild(media);
    var actions = el("div", "hqm-row");
    var extra = el("div", "hqm-result-detail");
    var kind = item.kind || item.type;
    var id = encodeURIComponent(item.id || "");
    var artist = (item.artists || [])[0] || "";
    function showItems(items, type) {
      extra.replaceChildren();
      if (!items.length) extra.appendChild(el("p", "hqm-muted", "Aucun résultat."));
      items.forEach(function (row) {
        extra.appendChild(renderMusicCard(Object.assign({ kind: type }, row)));
      });
    }
    async function albumTracks() {
      var tracks = [];
      var offset = 0;
      do {
        var data = await call("/api/spotify/albums/" + id + "?offset=" + offset);
        tracks = tracks.concat(data.tracks || []);
        offset = data.next_offset;
      } while (offset != null);
      return tracks;
    }
    if (item.uri && kind !== "artist") {
      cardButton(actions, kind === "album" ? "▶ Lire l’album" : "▶ Lire", function () {
        return playerAction("play", kind === "track" ? { uris: [item.uri] } : { context_uri: item.uri });
      });
    }
    if (kind === "track" && item.uri) {
      cardButton(actions, "+ File", function () { return playerAction("queue_add", { uri: item.uri }); });
    }
    if (kind === "track" || kind === "album") {
      cardButton(actions, "+ Playlist…", async function () {
        var result = await call("/api/spotify/playlists?limit=50");
        var picker = el("select");
        picker.setAttribute("aria-label", "Playlist de destination");
        (result.items || []).forEach(function (playlist) {
          var option = el("option", "", playlist.name);
          option.value = playlist.id;
          picker.appendChild(option);
        });
        extra.replaceChildren(picker);
        if (!picker.options.length) {
          extra.appendChild(el("p", "hqm-muted", "Aucune playlist disponible."));
          return;
        }
        cardButton(extra, "Ajouter", async function () {
          var uris = kind === "track" ? [item.uri] : (await albumTracks()).map(function (t) { return t.uri; });
          for (var i = 0; i < uris.length; i += 100) {
            await call("/api/spotify/playlists/" + encodeURIComponent(picker.value) + "/tracks", "POST",
              { uris: uris.slice(i, i + 100) });
          }
          extra.replaceChildren(el("p", "hqm-muted", "Ajouté à la playlist."));
        });
        picker.focus();
      });
      if (item.id) cardButton(actions, "★ Sauver découverte", async function () {
        await call("/api/music/discoveries", "POST", { items: [{
          title: item.name, artist: artist, source_url: "https://open.spotify.com/" + kind + "/" + id
        }] });
        status("Découverte sauvée.");
      });
      [["👍", "J’aime", true], ["👎", "Je n’aime pas", false]].forEach(function (option) {
        var feedback = cardButton(actions, option[0], async function () {
          await call("/api/music/feedback", "POST", {
            title: item.name, artist: artist, liked: option[2], uri: item.uri
          });
          status("Avis enregistré.");
        });
        feedback.setAttribute("aria-label", option[1] + " · " + item.name);
      });
    }
    if (kind === "album") cardButton(actions, "Ouvrir", async function () {
      showItems(await albumTracks(), "track");
    });
    if (kind === "artist") {
      cardButton(actions, "Page artiste", function () {
        openArtist({ id: item.id, name: item.name, image: item.image });
        return Promise.resolve();
      });
      cardButton(actions, "Discographie", async function () {
        var data = await call("/api/spotify/artists/" + id + "/albums");
        showItems(data.albums || [], "album");
      });
      cardButton(actions, "Titres", async function () {
        var data = await call("/api/spotify/search?type=track&q=" +
          encodeURIComponent('artist:"' + item.name.replaceAll('"', ' ') + '"'));
        showItems(data.tracks || [], "track");
      });
      cardButton(actions, "Bannir", async function () {
        await updateTaste({ ban: item.name });
        status("Artiste banni.");
      });
    }
    if (kind === "playlist") {
      cardButton(actions, "Ouvrir", async function () {
        var data = await call("/api/spotify/playlists/" + id + "/tracks");
        showItems(data.items || [], "track");
      });
      cardButton(actions, "Mixer+", function () {
        if (!state.mixerSources.some(function (source) { return source.id === item.id; })) {
          state.mixerSources.push({ id: item.id, name: item.name, weight: 1 });
        }
        setTab("mixer");
      });
    }
    card.append(actions, extra);
    return card;
  }

  function renderMusica(host) {
    var card = el("section", "hqm-card hqm-musica-card");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Musica"));
    copy.appendChild(el("p", "hqm-muted", "Ton intendante musicale — playlists, découvertes et sessions Mixer."));
    head.appendChild(copy);
    var headActions = el("div", "hqm-row");
    headActions.appendChild(btn("Cadeaux", "hqm-btn secondary", function () { setTab("studio"); }));
    headActions.appendChild(menuButton("Actions Musica", [
      { label: "Effacer le fil", danger: true, run: function () {
        call("/api/musica/clear", "POST", {}).then(function () {
          state.musicaThread = [];
          status("Fil Musica effacé.");
          render();
        }).catch(function (e) { status(e.message, true); });
      } }
    ]));
    head.appendChild(headActions);
    card.appendChild(head);

    var greeting = el("p", "hqm-muted hqm-musica-greeting");
    card.appendChild(greeting);
    renderGreeting(greeting);

    var settings = el("details", "hqm-musica-settings");
    var settingsSummary = document.createElement("summary");
    settingsSummary.textContent = "Réglages et confidentialité";
    settings.appendChild(settingsSummary);
    var settingsBody = el("div", "hqm-musica-settings-body");
    var privacyLabel = el("label", "hqm-check");
    var privacy = el("input");
    privacy.type = "checkbox";
    privacy.checked = state.historySharing !== false;
    privacy.disabled = state.historySharing == null || !!state.musicaBusy;
    privacyLabel.append(privacy, "Partager l'historique d'écoute avec Musica");
    privacy.addEventListener("change", async function () {
      privacy.disabled = true;
      try {
        var data = await call("/api/musica/taste", "POST", { history_sharing: privacy.checked });
        state.historySharing = data.taste.history_sharing;
      } catch (err) {
        status(err.message, true);
      } finally {
        render();
      }
    });
    settingsBody.appendChild(privacyLabel);
    var speakLabel = el("label", "hqm-check");
    var speak = el("input");
    speak.type = "checkbox";
    speak.checked = !!state.musicaSpeaks;
    speakLabel.append(speak, "Lire les réponses à voix haute");
    speak.addEventListener("change", function () {
      state.musicaSpeaks = speak.checked;
      try { localStorage.setItem(VOICE_KEY, String(speak.checked)); } catch (_e) {}
    });
    settingsBody.appendChild(speakLabel);
    settingsBody.appendChild(el("p", "hqm-muted",
      "Musica garde une mémoire séparée d'Else et de Transferania."));
    settings.appendChild(settingsBody);
    card.appendChild(settings);

    var log = el("div", "hqm-chat-log");
    log.setAttribute("aria-live", "polite");
    if (!state.musicaLoaded) {
      for (var bubbleIndex = 0; bubbleIndex < 2; bubbleIndex += 1) {
        var loadingBubble = el("div", "hqm-chat-bubble is-assistant hqm-skel-bubble");
        loadingBubble.appendChild(el("span", "hqm-skel-line w30"));
        loadingBubble.appendChild(el("span", "hqm-skel-line w90"));
        loadingBubble.appendChild(el("span", "hqm-skel-line w60"));
        log.appendChild(loadingBubble);
      }
    }
    (state.musicaThread || []).forEach(function (m) {
      if (m.role === "tool") return;
      var bubble = el("div", "hqm-chat-bubble is-" + (m.role === "assistant" ? "assistant" : "user"));
      bubble.appendChild(el("strong", "", m.role === "assistant" ? "Musica" : "Toi"));
      bubble.appendChild(el("p", ""));
      bubble.lastChild.textContent = m.text || "";
      (m.actions || []).forEach(function (action) {
        var labels = {
          play: "Lancer la lecture", play_album: "Lire l’album", queue_add: "Ajouter à la file",
          ban_artist: "Bannir l’artiste", remove_from_playlist: "Retirer de la playlist",
          delete_preset: "Supprimer le préréglage", clear_preferences: "Effacer les préférences",
          add_to_playlist: "Ajouter à la playlist", create_playlist: "Créer la playlist",
          save_discovery: "Sauver la découverte", save_album: "Sauver l’album",
          update_preferences: "Mettre à jour les préférences", record_feedback: "Enregistrer l’avis",
          wake_local_spotify: "Réveiller Spotify", mixer_play_last: "Lire la session Mixer",
          explore: "Créer l’exploration", save_keepers: "Sauver les gardés", activity_mix: "Préparer la session"
        };
        var label = labels[action.name];
        if (!label) return;
        if (action.target) label += " · " + action.target;
        if (action.needs_confirmation) {
          bubble.appendChild(btn("Confirmer · " + label, "hqm-btn secondary", async function () {
            try {
              var result = await call("/api/musica/confirm", "POST", { token: action.token });
              state.musicaThread = result.thread;
              render();
            } catch (err) { status(err.message, true); }
          }));
        } else {
          bubble.appendChild(el("p", "hqm-muted", (action.ok ? "✓ " : "× ") + label));
          if (action.ok && action.name === "explore") {
            if (action.code) bubble.appendChild(el("p", "hqm-muted", "Playlist créée. Lecture Spotify indisponible."));
            cardButton(bubble, "Sauver les titres aimés", function () {
              return sendMusica("Sauvegarde mes titres aimés de l’exploration dans Musica · Gardés.");
            });
          }
        }
      });
      if (m.tools && m.tools.length) {
        bubble.appendChild(el("span", "hqm-muted", "Outils : " + m.tools.map(function (t) {
          return (t.name || "?") + (t.ok === false ? "✗" : "✓");
        }).join(", ")));
      }
      (m.cards || []).forEach(function (item) { bubble.appendChild(renderMusicCard(item)); });
      log.appendChild(bubble);
    });
    if (state.musicaLoaded && !(state.musicaThread || []).length) {
      log.appendChild(el("p", "hqm-muted", "Dis-lui : « trouve du Sabaton », « génère un mixer depuis mes playlists », « réveille Spotify PC »…"));
    }
    if (state.musicaBusy) {
      var typing = el("div", "hqm-chat-bubble is-assistant hqm-typing");
      typing.setAttribute("aria-label", "Musica réfléchit…");
      typing.appendChild(el("strong", "", "Musica"));
      var typingRow = el("div", "hqm-typing-row");
      typingRow.appendChild(el("span", "", "Musica écrit"));
      var dots = el("span", "hqm-typing-dots");
      dots.append(el("i"), el("i"), el("i"));
      typingRow.appendChild(dots);
      typing.appendChild(typingRow);
      log.appendChild(typing);
    }
    if (state.musicaError) {
      var error = el("div", "hqm-chat-bubble is-assistant", state.musicaError);
      cardButton(error, "Réessayer", function () { return sendMusica(state.musicaDraft, state.musicaContext); });
      log.appendChild(error);
    }
    card.appendChild(log);
    log.addEventListener("scroll", function () {
      state.musicaStick = log.scrollHeight - log.scrollTop - log.clientHeight < 48;
    });
    var previousCount = state.musicaRenderedCount || 0;
    state.musicaScrollBottom = state.musicaStick !== false || (state.musicaThread || []).length > previousCount;
    state.musicaRenderedCount = (state.musicaThread || []).length;

    var chips = el("div", "hqm-row");
    [
      ["C’est quoi ?", "Qu’est-ce qui joue maintenant ?"],
      ["Réveiller PC", "Réveille Spotify sur ce PC et dis-moi les appareils Connect."],
      ["Découvrir", "Propose-moi des pistes selon mon profil (search Spotify uniquement)."]
    ].forEach(function (pair) {
      chips.appendChild(btn(pair[0], "hqm-chip", function () {
        sendMusica(pair[1]).catch(function () {});
      }));
    });
    card.appendChild(chips);

    var composer = el("div", "hqm-chat-composer");
    var input = document.createElement("textarea");
    input.rows = 2;
    input.placeholder = "Parler à Musica…";
    input.value = state.musicaDraft || "";
    input.addEventListener("input", function () { state.musicaDraft = input.value; });
    input.setAttribute("aria-label", "Message à Musica");
    input.setAttribute("enterkeyhint", "send");
    input.setAttribute("autocapitalize", "sentences");
    input.addEventListener("focus", function () { setTimeout(keepComposerVisible, 320); });
    input.addEventListener("blur", function () {
      document.body.classList.remove("hqm-keyboard-open");
      if (state.tab === "musica") setTimeout(revealMusicaComposer, 220);
    });
    input.disabled = !!state.musicaBusy;
    composer.appendChild(input);
    var actions = el("div", "hqm-chat-actions");
    pushToTalk(actions, input);
    var send = btn(state.musicaBusy ? "…" : "Envoyer", "hqm-btn", function () {
      var value = input.value;
      input.value = "";
      sendMusica(value).catch(function () {});
    });
    send.disabled = !!state.musicaBusy;
    actions.appendChild(send);
    composer.appendChild(actions);
    input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
        ev.preventDefault();
        send.click();
      }
    });
    card.insertBefore(chips, log);
    card.insertBefore(composer, log);
    host.appendChild(card);
  }

  function renderDisconnected(host) {
    var card = el("section", "hqm-card");
    card.appendChild(el("h3", "", "Connexion Spotify"));
    var conf = state.spotify || {};
    if (conf.configured === false) {
      card.appendChild(el("p", "", "Spotify n'est pas encore configuré sur ce pont."));
      var details = document.createElement("details");
      details.className = "hqm-advanced";
      var summary = document.createElement("summary");
      summary.textContent = "Configuration";
      details.appendChild(summary);
      var body = el("div", "hqm-advanced-body");
      body.appendChild(el("p", "hqm-muted",
        "Ajoute spotify_client_id (et optionnellement spotify_client_secret, spotify_redirect_uri) dans bridge_config.json, puis redéclare l'URI de redirection dans le Spotify Developer Dashboard."));
      if (conf.redirect_uri) body.appendChild(el("p", "hqm-muted", "URI attendue : " + conf.redirect_uri));
      details.appendChild(body);
      card.appendChild(details);
    } else if (!state.spotify) {
      card.appendChild(el("p", "", "Impossible de joindre Spotify pour le moment."));
      card.appendChild(btn("Réessayer", "hqm-btn secondary", function () {
        bootstrap().catch(function (e) { status(e.message, true); });
      }));
    } else {
      card.appendChild(el("p", "", "Connecte ton compte Spotify Premium pour piloter la lecture, les appareils Connect et tes playlists."));
      card.appendChild(el("p", "hqm-muted", "Tes playlists, découvertes et créations restent disponibles sans connexion."));
      card.appendChild(btn("Connecter Spotify", "hqm-btn", function () {
        connectSpotify().catch(function (e) { status(e.message, true); });
      }));
    }
    host.appendChild(card);
  }

  // Open / close Spotify Desktop on this PC through the Engine routes (admin only).
  async function pcPower(action) {
    if (state.pcBusy) return;
    state.pcBusy = true;
    render();
    try {
      var data = await call("/api/engine/daemons/spotify/" + action, "POST", {});
      if (data && data.ok === false) status(data.message || "Action impossible.", true);
      else status(action === "start" ? "Spotify Desktop ouvert." : "Spotify Desktop fermé.");
    } catch (e) {
      status(e.message, true);
    }
    state.pcBusy = false;
    try { state.spotify = await refreshStatus(); } catch (e) {}
    render();
  }

  function renderLecture(host) {
    if (!state.spotify || !state.spotify.connected) {
      renderDisconnected(host);
      return;
    }

    var pc = el("section", "hqm-card hqm-pc-card");
    var pcLocal = state.localSpotify || (state.spotify && state.spotify.local) || null;
    var pcOpen = !!(pcLocal && pcLocal.spotify_desktop_running);
    var pcHead = el("div", "hqm-card-head");
    pcHead.appendChild(el("h3", "", "Spotify sur ce PC"));
    pcHead.appendChild(el("span", "hqm-badge " + (pcOpen ? "ok" : ""), pcOpen ? "Ouvert" : "Fermé"));
    pc.appendChild(pcHead);
    var pcRow = el("div", "hqm-row");
    var pcOpenBtn = btn(state.pcBusy ? "…" : "Ouvrir Spotify", "hqm-btn", function () { pcPower("start"); });
    var pcCloseBtn = btn(state.pcBusy ? "…" : "Fermer Spotify", "hqm-btn secondary", function () { pcPower("stop"); });
    pcOpenBtn.disabled = pcCloseBtn.disabled = !!state.pcBusy;
    pcRow.appendChild(pcOpenBtn);
    pcRow.appendChild(pcCloseBtn);
    pc.appendChild(pcRow);
    host.appendChild(pc);

    var now = el("section", "hqm-card hqm-now-card");
    var backdrop = el("img", "hqm-now-backdrop");
    backdrop.alt = "";
    backdrop.setAttribute("aria-hidden", "true");
    backdrop.setAttribute("data-hqm", "hero-backdrop");
    backdrop.hidden = true;
    now.appendChild(backdrop);
    var head = el("div", "hqm-card-head");
    head.appendChild(el("h3", "", "En lecture"));
    head.appendChild(el("span", "hqm-badge ok", "Spotify"));
    now.appendChild(head);

    var hero = el("div", "hqm-hero");
    var artWrap = el("div", "hqm-art-wrap is-empty");
    var art = el("img", "hqm-art");
    art.setAttribute("data-hqm", "art");
    art.setAttribute("data-hqm-art-size", "hero");
    art.alt = "";
    art.hidden = true;
    artWrap.appendChild(art);
    artWrap.appendChild(el("span", "hqm-art-note", "♪"));
    hero.appendChild(artWrap);

    var meta = el("div", "hqm-hero-meta");
    var title = el("strong", "hqm-hero-title");
    title.setAttribute("data-hqm", "track-title");
    var artist = el("span", "hqm-hero-artist");
    artist.setAttribute("data-hqm", "track-artist");
    var album = el("span", "hqm-hero-album");
    album.setAttribute("data-hqm", "track-album");
    meta.append(title, artist, album);

    var playingOnly = el("div", "hqm-playing-only");
    var progress = document.createElement("input");
    progress.type = "range";
    progress.className = "hqm-progress";
    progress.setAttribute("data-hqm", "progress");
    progress.setAttribute("aria-label", "Position dans le morceau");
    progress.min = "0";
    progress.value = String(estimatedProgressMs());
    progress.addEventListener("pointerdown", function () { state.seeking = true; });
    progress.addEventListener("pointerup", function () { state.seeking = false; });
    progress.addEventListener("change", function () {
      var ms = Number(progress.value) || 0;
      state.seeking = false;
      state.progressAnchorMs = ms;
      state.progressAnchorAt = Date.now();
      if (state.player) state.player.progress_ms = ms;
      paintProgress();
      playerAction("seek", { position_ms: ms }).catch(function (e) { status(friendlyPlayerError(e), true); });
    });
    playingOnly.appendChild(progress);
    var times = el("span", "hqm-times");
    times.setAttribute("data-hqm", "times");
    playingOnly.appendChild(times);
    meta.appendChild(playingOnly);

    var transport = el("div", "hqm-transport");
    transport.appendChild(iconBtn("Précédent", "previous", function () {
      playerAction("previous").catch(function (e) { status(friendlyPlayerError(e), true); });
    }));
    var toggle = iconBtn("Lancer la lecture", "play", function () {
      togglePlayback()
        .catch(function (e) { status(friendlyPlayerError(e), true); });
    }, "hqm-play");
    toggle.setAttribute("data-hqm", "toggle");
    transport.appendChild(toggle);
    transport.appendChild(iconBtn("Suivant", "next", function () {
      playerAction("next").catch(function (e) { status(friendlyPlayerError(e), true); });
    }));
    meta.appendChild(transport);

    var extras = el("div", "hqm-row hqm-now-extras");
    var shuffle = toggleButton("Aléatoire", "shuffle", function () {
      playerAction("shuffle", { state: !(state.player && state.player.shuffle_state) })
        .catch(function (e) { status(friendlyPlayerError(e), true); });
    });
    shuffle.setAttribute("data-hqm", "shuffle");
    extras.appendChild(shuffle);
    var repeat = toggleButton("Répéter", "repeat", function () {
      var current = (state.player && state.player.repeat_state) || "off";
      var next = current === "off" ? "context" : (current === "context" ? "track" : "off");
      playerAction("repeat", { state: next }).catch(function (e) { status(friendlyPlayerError(e), true); });
    });
    repeat.setAttribute("data-hqm", "repeat");
    extras.appendChild(repeat);
    var volume = el("label", "hqm-volume");
    volume.appendChild(svgIcon(ICONS.volume));
    var vol = document.createElement("input");
    vol.type = "range";
    vol.min = "0";
    vol.max = "100";
    vol.value = String((state.player && state.player.device && state.player.device.volume_percent) || 50);
    vol.setAttribute("data-hqm", "volume");
    vol.setAttribute("aria-label", "Volume");
    vol.addEventListener("change", function () {
      playerAction("volume", { volume_percent: Number(vol.value) })
        .catch(function (e) { status(friendlyPlayerError(e), true); });
    });
    volume.appendChild(vol);
    extras.appendChild(volume);
    var sleep = sleepMenu();
    var sleepSummary = sleep.querySelector("summary");
    sleepSummary.classList.add("hqm-toggle");
    sleepSummary.replaceChildren(el("span", "", state.sleep ? "☾ Minuteur actif" : "☾ Minuteur"));
    extras.appendChild(sleep);
    var djLive = !!(state.djShow && state.djShow.active);
    var djToggle = toggleButton(djLive ? "DJ en ondes" : "DJ Musica", "chat", function () {
      var task = state.djShow && state.djShow.active
        ? call("/api/musica/dj/stop", "POST", {}).then(function (data) { state.djShow = data; status("DJ Musica hors antenne."); })
        : djStart({ show: "dj" });
      Promise.resolve(task).then(function () { render(); }).catch(function (e) { status(e.message, true); });
    });
    djToggle.classList.toggle("is-on", djLive);
    djToggle.setAttribute("aria-pressed", djLive ? "true" : "false");
    extras.appendChild(djToggle);
    meta.appendChild(extras);

    var empty = el("div", "hqm-empty-cta hqm-empty-only");
    empty.appendChild(btn("Parcourir les playlists", "hqm-btn", function () { setTab("playlists"); }));
    empty.appendChild(btn("Voir les découvertes", "hqm-btn secondary", function () { setTab("decouvertes"); }));
    meta.appendChild(empty);
    hero.appendChild(meta);
    now.appendChild(hero);
    host.appendChild(now);
    host.appendChild(renderDjCard());
    host.appendChild(renderStationCard());

    if ((state.playlists || []).length) {
      var playlists = el("section", "hqm-card hqm-playlists-card");
      var plHead = el("div", "hqm-card-head");
      plHead.appendChild(el("h3", "", "Tes playlists"));
      plHead.appendChild(btn("Tout voir", "hqm-btn secondary", function () { setTab("playlists"); }));
      playlists.appendChild(plHead);
      var row = el("div", "hqm-preview-row");
      state.playlists.slice(0, 5).forEach(function (pl) {
        var card = btn("", "hqm-mini-pl", function () {
          setTab("playlists");
          openPlaylist(pl.id).then(render).catch(function (e) { status(e.message, true); });
        });
        card.setAttribute("aria-label", "Ouvrir " + pl.name);
        if (pl.image) {
          var cover = el("img", "hqm-mini-cover");
          cover.alt = "";
          cover.loading = "lazy";
          applyCover(cover, pl.image, 160, "(max-width: 700px) 140px, 160px");
          card.appendChild(cover);
        } else {
          card.appendChild(el("div", "hqm-mini-cover"));
        }
        card.appendChild(el("strong", "", pl.name));
        card.appendChild(el("span", "", pl.tracks_total != null ? pl.tracks_total + " titres" : "Playlist"));
        row.appendChild(card);
      });
      playlists.appendChild(row);
      host.appendChild(playlists);
    }

    var releases = (state.radar && state.radar.items) || [];
    var discover = el("section", "hqm-card hqm-releases-card");
    var discHead = el("div", "hqm-card-head");
    discHead.appendChild(el("h3", "", "Nouveautés"));
    discHead.appendChild(btn(releases.length ? "Tout voir" : "Découvrir", "hqm-btn secondary", function () {
      setTab("decouvertes");
    }));
    discover.appendChild(discHead);
    if (releases.length) {
      var discRow = el("div", "hqm-preview-row");
      releases.slice(0, 4).forEach(function (albumItem) {
        var discCard = btn("", "hqm-mini-pl", function () { setTab("decouvertes"); });
        discCard.setAttribute("aria-label", "Voir " + albumItem.name);
        if (albumItem.image) {
          var discCover = el("img", "hqm-mini-cover");
          discCover.alt = "";
          discCover.loading = "lazy";
          applyCover(discCover, albumItem.image, 160, "(max-width: 700px) 140px, 160px");
          discCard.appendChild(discCover);
        } else {
          discCard.appendChild(el("div", "hqm-mini-cover"));
        }
        discCard.appendChild(el("strong", "", albumItem.name));
        discCard.appendChild(el("span", "", (albumItem.artists || []).join(", ")));
        discRow.appendChild(discCard);
      });
      discover.appendChild(discRow);
    } else {
      discover.appendChild(el("p", "hqm-muted", "Le radar cherche des sorties récentes. Ouvre Découvertes pour le lancer."));
    }
    host.appendChild(discover);

    var activeDevice = (state.devices || []).find(function (d) { return d.is_active; }) || null;
    var devices = disclosureCard("Appareils Spotify", "hqm-devices");
    devices.summary.appendChild(el("span", "hqm-muted", activeDevice ? activeDevice.name : "Aucun appareil actif"));
    devices.body.appendChild(el("p", "hqm-muted",
      "Choisis où jouer. Spotify Connect ne voit que l'app Spotify — pas le panneau Son de Windows."));
    var local = state.localSpotify || (state.spotify && state.spotify.local) || null;
    if (local) {
      devices.body.appendChild(el("p", local.spotify_desktop_running ? "hqm-muted" : "hqm-muted",
        "PC « " + (local.hostname || "?") + " » · Spotify Desktop " +
        (local.spotify_desktop_running ? "ouvert" : "fermé")));
    }
    var deviceActions = el("div", "hqm-row");
    deviceActions.appendChild(btn("Actualiser", "hqm-btn secondary", function () {
      loadDevices().then(render).catch(function (e) { status(e.message, true); });
    }));
    deviceActions.appendChild(btn("Réveiller Spotify PC", "hqm-btn secondary", function () {
      wakeLocalSpotify().catch(function (e) { status(e.message, true); });
    }));
    devices.body.appendChild(deviceActions);
    if (!(state.devices || []).length) {
      devices.body.appendChild(el("p", "hqm-muted", "Aucun appareil visible. Ouvre Spotify sur ce PC, ton téléphone ou ta Fire TV, puis actualise."));
    } else {
      var list = el("ul", "hqm-list");
      state.devices.forEach(function (device) {
        var li = el("li", "");
        var info = el("div", "hqm-track-meta");
        var preferred = state.preferredDeviceId === device.id;
        info.appendChild(el("strong", "", (device.name || "Appareil") +
          (device.is_active ? " · actif" : "") + (preferred ? " · préféré" : "") +
          (device.is_local_candidate ? " · ce PC" : "")));
        info.appendChild(el("span", "", (device.type || "") + (device.is_restricted ? " · restreint" : "")));
        li.appendChild(info);
        if (!device.is_restricted) {
          var actions = el("div", "hqm-row");
          actions.appendChild(btn(device.is_active ? "Actif" : "Transférer", "hqm-btn secondary", function () {
            savePreferredDevice(device.id);
            playerAction("transfer", { device_id: device.id, play: true })
              .then(loadDevices).then(render).catch(function (e) { status(e.message, true); });
          }));
          actions.appendChild(btn(preferred ? "Préféré" : "Préférer", preferred ? "hqm-btn" : "hqm-btn secondary", function () {
            savePreferredDevice(preferred ? "" : device.id);
            render();
            status(preferred ? "Préférence appareil effacée." : "Appareil préféré : " + (device.name || device.id));
          }));
          li.appendChild(actions);
        }
        list.appendChild(li);
      });
      devices.body.appendChild(list);
    }
    host.appendChild(devices.root);

    var queue = disclosureCard("File d'attente", "hqm-queue");
    host.appendChild(queue.root);
    fillQueue(queue.body);

    updateNowPlayingDom();
  }

  function renderPlaylists(host) {
    if (!state.spotify || !state.spotify.connected) {
      renderDisconnected(host);
      return;
    }
    function openPlaylistAndRender(id) {
      state.playlistDetailLoading = id;
      render();
      openPlaylist(id).then(function () {
        state.playlistDetailLoading = null;
        render();
        if (window.innerWidth < 900) window.scrollTo(0, 0);
      }).catch(function (e) {
        state.playlistDetailLoading = null;
        render();
        status(e.message, true);
      });
    }
    function addMixer(playlist) {
      if (!state.mixerSources.some(function (source) { return source.id === playlist.id; })) {
        state.mixerSources.push({ id: playlist.id, name: playlist.name, weight: 1 });
      }
      setTab("mixer");
    }

    var grid = el("div", "hqm-grid-2" + (state.openPlaylist ? " has-detail" : ""));
    var left = el("section", "hqm-card");
    var head = el("div", "hqm-card-head");
    head.appendChild(el("h3", "", "Playlists"));
    head.appendChild(el("span", "hqm-muted",
      state.playlistTotal ? state.playlistTotal + " playlists" : ""));
    left.appendChild(head);

    var searchWrap = el("label", "hqm-search");
    searchWrap.appendChild(svgIcon(ICONS.search));
    var search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filtrer mes playlists…";
    search.value = state.playlistQuery || "";
    search.setAttribute("data-hqm", "playlist-search");
    search.setAttribute("aria-label", "Filtrer les playlists");
    var searchTimer = null;
    function runSearch() {
      clearTimeout(searchTimer);
      state.playlistQuery = search.value;
      loadPlaylists(true).then(function () {
        render();
        var next = state.host.querySelector("[data-hqm='playlist-search']");
        if (next) {
          next.focus();
          next.setSelectionRange(next.value.length, next.value.length);
        }
      }).catch(function (e) { status(e.message, true); });
    }
    search.addEventListener("input", function () {
      state.playlistQuery = search.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 350);
    });
    search.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        runSearch();
      }
    });
    searchWrap.appendChild(search);
    if (state.playlistsLoading) searchWrap.appendChild(el("span", "hqm-spinner"));
    left.setAttribute("aria-busy", state.playlistsLoading ? "true" : "false");

    var filter = el("div", "hqm-pl-filter");
    filter.appendChild(searchWrap);
    var sort = document.createElement("select");
    sort.className = "hqm-select";
    sort.setAttribute("data-hqm", "playlist-sort");
    sort.setAttribute("aria-label", "Trier les playlists");
    [
      ["default", "Ordre Spotify"],
      ["name", "Nom A–Z"],
      ["tracks", "Plus de titres"],
      ["owner", "Propriétaire"]
    ].forEach(function (option) {
      var node = document.createElement("option");
      node.value = option[0];
      node.textContent = option[1];
      sort.appendChild(node);
    });
    sort.value = state.playlistSort || "default";
    sort.addEventListener("change", function () {
      state.playlistSort = sort.value;
      render();
    });
    filter.appendChild(sort);
    left.appendChild(filter);

    var create = el("details", "hqm-create");
    var createSummary = document.createElement("summary");
    createSummary.textContent = "+ Nouvelle playlist";
    create.appendChild(createSummary);
    var createBody = el("div", "hqm-create-body");
    var createName = document.createElement("input");
    createName.type = "text";
    createName.placeholder = "Nom de la playlist";
    createName.setAttribute("data-hqm", "new-playlist");
    createName.setAttribute("aria-label", "Nom de la nouvelle playlist");
    createBody.appendChild(createName);
    createBody.appendChild(btn("Créer", "hqm-btn", function () {
      if (!createName.value.trim()) {
        status("Donne un nom à la playlist.", true);
        return;
      }
      call("/api/spotify/playlists", "POST", { name: createName.value.trim(), public: false })
        .then(function () { return loadPlaylists(true); })
        .then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    create.appendChild(createBody);
    left.appendChild(create);

    var list = el("ul", "hqm-list hqm-pl-list");
    var playlists = state.playlists.slice();
    if (state.playlistSort === "name") {
      playlists.sort(function (a, b) { return (a.name || "").localeCompare(b.name || "", "fr"); });
    } else if (state.playlistSort === "tracks") {
      playlists.sort(function (a, b) {
        return ((b.tracks_total || 0) - (a.tracks_total || 0)) ||
          (a.name || "").localeCompare(b.name || "", "fr");
      });
    } else if (state.playlistSort === "owner") {
      playlists.sort(function (a, b) {
        return (a.owner || "").localeCompare(b.owner || "", "fr") ||
          (a.name || "").localeCompare(b.name || "", "fr");
      });
    }
    var visible = Math.max(12, state.playlistVisible || 12);
    if (state.playlistsLoading && !playlists.length) {
      for (var skel = 0; skel < 5; skel += 1) {
        var skelRow = el("li", "hqm-pl-row hqm-skel-row");
        skelRow.appendChild(el("span", "hqm-skel-cover"));
        var skelMeta = el("div", "hqm-skel-meta");
        skelMeta.appendChild(el("span", "hqm-skel-line w70"));
        skelMeta.appendChild(el("span", "hqm-skel-line w40"));
        skelRow.appendChild(skelMeta);
        list.appendChild(skelRow);
      }
    }
    playlists.slice(0, visible).forEach(function (playlist) {
      var li = el("li", "hqm-pl-row");
      li.setAttribute("data-playlist-id", playlist.id);
      var open = btn("", "hqm-pl-open", function () { openPlaylistAndRender(playlist.id); });
      open.type = "button";
      open.setAttribute("aria-label", "Ouvrir " + playlist.name);
      if (playlist.image) {
        var cover = el("img", "hqm-pl-cover");
        cover.alt = "";
        cover.loading = "lazy";
        cover.decoding = "async";
        applyCover(cover, playlist.image, 48);
        open.appendChild(cover);
      } else {
        open.appendChild(el("div", "hqm-pl-cover"));
      }
      var meta = el("div", "hqm-track-meta");
      meta.appendChild(el("strong", "", playlist.name || "Playlist"));
      meta.appendChild(el("span", "", (playlist.tracks_total != null ? playlist.tracks_total + " titres" : "") +
        (playlist.owner ? " · " + playlist.owner : "")));
      open.appendChild(meta);
      open.appendChild(playingBars());
      li.appendChild(open);
      li.appendChild(menuButton("Actions pour " + playlist.name, [
        { label: "Lire", run: function () {
          playerAction("play", { context_uri: playlist.uri || ("spotify:playlist:" + playlist.id) })
            .catch(function (e) { status(friendlyPlayerError(e), true); });
        } },
        { label: "Mixer+", run: function () { addMixer(playlist); } }
      ], "is-inline"));
      list.appendChild(li);
    });
    if (!state.playlistsLoading && !playlists.length) {
      list.appendChild(el("li", "hqm-muted",
        state.playlistQuery ? "Aucune playlist ne correspond à ce filtre." : "Aucune playlist pour le moment."));
    }
    left.appendChild(list);
    if (!state.playlistsLoading && playlists.length > visible) {
      left.appendChild(btn(
        "Afficher " + Math.min(12, playlists.length - visible) + " autres",
        "hqm-btn secondary hqm-load-more",
        function () {
          state.playlistVisible = visible + 12;
          render();
        }
      ));
    }
    if (!state.playlistsLoading && state.playlists.length < state.playlistTotal) {
      left.appendChild(btn("Charger plus de playlists", "hqm-btn secondary hqm-load-more", function () {
        loadPlaylists(false).then(render).catch(function (e) { status(e.message, true); });
      }));
    }
    grid.appendChild(left);

    var right = el("section", "hqm-card hqm-detail");
    if (!state.openPlaylist && state.playlistDetailLoading) {
      right.appendChild(skeletonDetail());
    } else if (!state.openPlaylist) {
      var empty = el("div", "hqm-empty");
      empty.appendChild(el("span", "hqm-empty-note", "♪"));
      empty.appendChild(el("strong", "", "Choisis une playlist"));
      empty.appendChild(el("p", "hqm-muted", "Ses titres, sa description et ses actions apparaîtront ici."));
      empty.appendChild(btn("Créer une playlist", "hqm-btn secondary", function () {
        create.open = true;
        var input = state.host.querySelector("[data-hqm='new-playlist']");
        if (input) input.focus();
      }));
      right.appendChild(empty);
    } else {
      right.appendChild(btn("‹ Toutes les playlists", "hqm-btn secondary hqm-detail-back", function () {
        state.openPlaylist = null;
        render();
        window.scrollTo(0, 0);
      }));
      var detailHead = el("div", "hqm-card-head");
      detailHead.appendChild(el("h3", "", state.openPlaylist.name || "Playlist"));
      detailHead.appendChild(menuButton("Actions pour la playlist", [
        { label: "Lire la playlist", run: function () {
          playerAction("play", { context_uri: state.openPlaylist.uri || ("spotify:playlist:" + state.openPlaylist.id) })
            .catch(function (e) { status(friendlyPlayerError(e), true); });
        } },
        { label: "Mixer+", run: function () { addMixer(state.openPlaylist); } }
      ]));
      right.appendChild(detailHead);
      var detailActions = el("div", "hqm-detail-actions");
      detailActions.appendChild(btn("Lire la playlist", "hqm-btn", function () {
        playerAction("play", { context_uri: state.openPlaylist.uri || ("spotify:playlist:" + state.openPlaylist.id) })
          .catch(function (e) { status(friendlyPlayerError(e), true); });
      }));
      right.appendChild(detailActions);
      if (state.openPlaylist.image) {
        var detailCover = el("img", "hqm-playlist-cover");
        detailCover.alt = "";
        applyCover(detailCover, state.openPlaylist.image, 190, "(max-width: 700px) 140px, 190px");
        right.appendChild(detailCover);
      }
      if (state.openPlaylist.description) {
        right.appendChild(el("p", "hqm-muted", state.openPlaylist.description));
      }
      var edit = el("details", "hqm-edit");
      var editSummary = document.createElement("summary");
      editSummary.textContent = "Modifier le nom et la description";
      edit.appendChild(editSummary);
      var editBody = el("div", "hqm-edit-body");
      var rename = document.createElement("input");
      rename.type = "text";
      rename.value = state.openPlaylist.name || "";
      rename.setAttribute("aria-label", "Renommer la playlist");
      editBody.appendChild(rename);
      var description = document.createElement("textarea");
      description.value = state.openPlaylist.description || "";
      description.setAttribute("aria-label", "Description de la playlist");
      editBody.appendChild(description);
      editBody.appendChild(btn("Enregistrer", "hqm-btn secondary", function () {
        call("/api/spotify/playlists/" + encodeURIComponent(state.openPlaylist.id), "POST", {
          name: rename.value,
          description: description.value
        }).then(function () { return openPlaylist(state.openPlaylist.id); })
          .then(render)
          .catch(function (e) { status(e.message, true); });
      }));
      edit.appendChild(editBody);
      right.appendChild(edit);

      var tracks = el("ul", "hqm-list");
      state.tracks.forEach(function (track, index) {
        var li = el("li", "hqm-track hqm-media-row");
        li.setAttribute("data-track-uri", track.uri || "");
        if (track.image) {
          var thumb = el("img", "hqm-thumb");
          thumb.alt = "";
          thumb.loading = "lazy";
          thumb.decoding = "async";
          applyCover(thumb, track.image, 48);
          li.appendChild(thumb);
        } else {
          li.appendChild(el("div", "hqm-thumb"));
        }
        var info = el("div", "hqm-track-meta");
        info.appendChild(el("strong", "", track.name || "?"));
        info.appendChild(el("span", "", (track.artists || []).join(", ")));
        li.appendChild(info);
        var actions = el("div", "hqm-row");
        actions.appendChild(iconBtn("Lire " + (track.name || "ce titre"), "play", function () {
          playerAction("play", { uris: [track.uri] })
            .catch(function (e) { status(friendlyPlayerError(e), true); });
        }));
        actions.appendChild(playingBars());
        actions.appendChild(menuButton("Actions pour " + (track.name || "ce titre"), [
          { label: "+ File", run: function () {
            playerAction("queue_add", { uri: track.uri })
              .then(function () { status("Ajouté à la file."); })
              .catch(function (e) { status(friendlyPlayerError(e), true); });
          } },
          { label: "Retirer de la playlist", danger: true, run: function () {
            call("/api/spotify/playlists/" + encodeURIComponent(state.openPlaylist.id) + "/tracks", "POST", {
              op: "remove",
              tracks: [{ uri: track.uri, positions: [index] }]
            }).then(function () { return openPlaylist(state.openPlaylist.id); })
              .then(render)
              .catch(function (e) { status(e.message, true); });
          } }
        ], "is-inline"));
        li.appendChild(actions);
        tracks.appendChild(li);
      });
      if (!state.tracks.length) tracks.appendChild(el("li", "hqm-muted", "Cette playlist est vide."));
      right.appendChild(tracks);
      if ((state.openPlaylist.tracks_total || 0) > state.tracks.length) {
        right.appendChild(btn("Charger plus de titres", "hqm-btn secondary", function () {
          loadPlaylistTracks(false).then(render).catch(function (e) { status(e.message, true); });
        }));
      }
    }
    grid.appendChild(right);
    host.appendChild(grid);

    var catalog = el("section", "hqm-card hqm-catalog");
    catalog.appendChild(el("h3", "", "Chercher dans Spotify"));
    catalog.appendChild(el("p", "hqm-muted", "Titres, albums, artistes et playlists du catalogue."));
    var controls = el("div", "hqm-catalog-controls");
    var catSearch = document.createElement("input");
    catSearch.type = "search";
    catSearch.setAttribute("data-hqm", "catalog-search");
    catSearch.placeholder = "Chercher dans Spotify…";
    catSearch.value = state.catalogQuery || "";
    catSearch.setAttribute("aria-label", "Recherche catalogue Spotify");
    catSearch.addEventListener("keydown", function (event) {
      if (event.key === "Enter") searchCatalog().catch(function (e) { status(e.message, true); });
    });
    controls.appendChild(catSearch);
    var types = el("select");
    types.setAttribute("data-hqm", "catalog-type");
    types.setAttribute("aria-label", "Type de résultat Spotify");
    [["track", "Titres"], ["album", "Albums"], ["artist", "Artistes"], ["playlist", "Playlists"]].forEach(function (pair) {
      var option = el("option", "", pair[1]);
      option.value = pair[0];
      types.appendChild(option);
    });
    types.value = state.catalogType || "track";
    controls.appendChild(types);
    controls.appendChild(btn("Rechercher", "hqm-btn", function () {
      searchCatalog().catch(function (e) { status(e.message, true); });
    }));
    catalog.appendChild(controls);
    if (state.searchResults) {
      var type = state.catalogType || "track";
      var rows = state.searchResults[type + "s"] || [];
      rows.forEach(function (row) {
        catalog.appendChild(renderMusicCard(Object.assign({ kind: type }, row)));
      });
      if (!rows.length) catalog.appendChild(el("p", "hqm-muted", "Aucun résultat."));
      if (state.searchResults.next_offset != null) {
        catalog.appendChild(btn("Charger plus", "hqm-btn secondary", function () {
          searchCatalog(true).catch(function (e) { status(e.message, true); });
        }));
      }
    }
    host.appendChild(catalog);
  }

  function renderMixer(host) {
    var intro = el("section", "hqm-card");
    intro.appendChild(el("h3", "", "Mixer"));
    intro.appendChild(el("p", "hqm-muted",
      "Compose une session à partir de tes playlists, règle l’équilibre, puis lance-la. La graine permet de rejouer exactement la même session."));
    if (!state.preferredDeviceId && !(state.devices || []).some(function (d) { return d.is_active; })) {
      var banner = el("div", "hqm-banner");
      banner.appendChild(el("span", "", "Aucun appareil Spotify actif — la lecture échouera."));
      banner.appendChild(btn("Choisir un appareil", "hqm-btn secondary", function () {
        setTab("lecture");
        requestAnimationFrame(function () {
          var devices = state.host && state.host.querySelector(".hqm-devices");
          if (devices) devices.open = true;
        });
      }));
      intro.appendChild(banner);
    }
    host.appendChild(intro);
    renderMood(host);

    var sourcesCard = el("section", "hqm-card");
    var sourcesHead = el("div", "hqm-card-head");
    sourcesHead.appendChild(el("h3", "", "Sources"));
    sourcesCard.appendChild(sourcesHead);
    var addRow = el("div", "hqm-row");
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Playlist source");
    select.appendChild(new Option("Choisir une playlist…", ""));
    state.playlists.forEach(function (playlist) {
      select.appendChild(new Option(playlist.name, playlist.id));
    });
    addRow.appendChild(select);
    addRow.appendChild(btn("Ajouter", "hqm-btn secondary", function () {
      var id = select.value;
      if (!id) return;
      var playlist = state.playlists.find(function (item) { return item.id === id; });
      if (!playlist) return;
      if (!state.mixerSources.some(function (source) { return source.id === id; })) {
        state.mixerSources.push({ id: playlist.id, name: playlist.name, weight: 1 });
        render();
      }
    }));
    sourcesCard.appendChild(addRow);

    var shares = weightShares();
    state.mixerSources.forEach(function (source, index) {
      var row = el("div", "hqm-source");
      var name = el("div", "hqm-source-name");
      name.appendChild(el("span", "", source.name));
      name.appendChild(el("span", "", (shares[index] || 0) + " %"));
      row.appendChild(name);
      var weight = document.createElement("input");
      weight.type = "range";
      weight.min = "0";
      weight.max = "10";
      weight.step = "0.5";
      weight.value = String(source.weight);
      weight.setAttribute("aria-label", "Poids de " + source.name);
      weight.addEventListener("input", function () {
        state.mixerSources[index].weight = Number(weight.value) || 0;
      });
      weight.addEventListener("change", function () { render(); });
      row.appendChild(weight);
      var energy = document.createElement("select");
      energy.className = "hqm-energy-select";
      energy.setAttribute("aria-label", "Énergie de " + source.name);
      [[1, "Calme"], [2, "Doux"], [3, "Posé"], [4, "Énergique"], [5, "Intense"]].forEach(function (pair) {
        energy.appendChild(new Option("⚡" + pair[0] + " " + pair[1], String(pair[0])));
      });
      energy.value = String(source.energy || 3);
      energy.addEventListener("change", function () { state.mixerSources[index].energy = Number(energy.value) || 3; });
      row.appendChild(energy);
      row.appendChild(btn("Retirer", "hqm-btn secondary", function () {
        state.mixerSources.splice(index, 1);
        render();
      }));
      sourcesCard.appendChild(row);
    });
    if (!state.mixerSources.length) {
      sourcesCard.appendChild(el("p", "hqm-muted", "Ajoute une ou plusieurs playlists pour commencer."));
    }
    host.appendChild(sourcesCard);

    var familiar = Math.round(Number(state.mixerConfig.familiarity || 0) * 100);
    var actionBar = el("div", "hqm-mixer-actions");
    actionBar.appendChild(el("span", "hqm-mixer-summary",
      state.mixerSources.length + (state.mixerSources.length === 1 ? " source" : " sources") +
      " · " + state.mixerConfig.length + " titres · " + familiar + " % connus"));
    actionBar.appendChild(btn("Générer + lire", "hqm-btn", function () {
      generateSession({ andPlay: true }).catch(function (e) { status(friendlyPlayerError(e), true); });
    }));
    actionBar.appendChild(btn("Générer seulement", "hqm-btn secondary", function () {
      generateSession().catch(function (e) { status(e.message, true); });
    }));
    actionBar.appendChild(menuButton("Autres actions", [
      { label: "Nouvelle graine", run: function () {
        state.mixerConfig.seed = "";
        generateSession({ andPlay: true }).catch(function (e) { status(friendlyPlayerError(e), true); });
      } },
      { label: "Lire la dernière session", run: function () {
        playSession().catch(function (e) { status(friendlyPlayerError(e), true); });
      } },
      { label: "Sauver dans Spotify", run: function () {
        saveSessionAsPlaylist().catch(function (e) { status(friendlyPlayerError(e), true); });
      } }
    ], "is-inline"));
    host.appendChild(actionBar);

    var settings = el("section", "hqm-card");
    settings.appendChild(el("h3", "", "Réglages"));
    var grid = el("div", "hqm-grid-2");
    grid.appendChild(rangeField("length", "Longueur de la session", 5, 100, 1,
      function (value) { return value + " titres"; }));
    grid.appendChild(rangeField("familiarity", "Familiarité", 0, 1, 0.05,
      function (value) { return Math.round(value * 100) + " %"; },
      "0 % exploratoire · 100 % titres connus"));
    grid.appendChild(rangeField("max_artist_frequency", "Maximum par artiste", 1, 10, 1,
      function (value) { return value + " titres"; }));
    grid.appendChild(rangeField("favorites_boost", "Boost des favoris", 0, 1, 0.05,
      function (value) { return Math.round(value * 100) + " %"; }));
    settings.appendChild(grid);
    var curveField = el("div", "hqm-field hqm-curve-field");
    curveField.appendChild(el("label", "hqm-label", "Courbe d’énergie"));
    var curve = document.createElement("select");
    curve.setAttribute("aria-label", "Courbe d’énergie de la session");
    [["none", "Aucune (ordre du Mixer)"], ["arc", "Échauffement → pic → retour au calme"], ["rise", "Montée progressive"],
      ["fall", "Descente progressive"], ["waves", "Vagues"], ["flat", "Plateau régulier"]].forEach(function (pair) {
      curve.appendChild(new Option(pair[1], pair[0]));
    });
    curve.value = state.mixerConfig.energy_curve || "none";
    var curvePreview = el("canvas", "hqm-curve-preview");
    curvePreview.setAttribute("aria-hidden", "true");
    curve.addEventListener("change", function () {
      state.mixerConfig.energy_curve = curve.value;
      drawCurve(curvePreview, curve.value);
    });
    curveField.append(curve, curvePreview);
    curveField.appendChild(el("p", "hqm-muted hqm-hint",
      "Donne une énergie à chaque source (⚡1 calme → ⚡5 intense) ; le Mixer ordonne la session selon la courbe."));
    settings.appendChild(curveField);
    requestAnimationFrame(function () { if (curvePreview.isConnected) drawCurve(curvePreview, curve.value); });

    var advanced = el("details", "hqm-advanced");
    var advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "Contraintes et graine";
    advanced.appendChild(advancedSummary);
    var advancedBody = el("div", "hqm-advanced-body");
    advancedBody.appendChild(rangeField("artist_window", "Écart entre deux titres du même artiste", 0, 20, 1,
      function (value) { return value + " titres"; }));
    advancedBody.appendChild(rangeField("album_window", "Écart entre deux titres du même album", 0, 20, 1,
      function (value) { return value + " titres"; }));
    var seedField = el("div", "hqm-field");
    seedField.appendChild(el("label", "hqm-label", "Graine (rejouable)"));
    var seed = document.createElement("input");
    seed.type = "text";
    seed.placeholder = "vide = aléatoire";
    seed.value = state.mixerConfig.seed == null ? "" : String(state.mixerConfig.seed);
    seed.addEventListener("change", function () { state.mixerConfig.seed = seed.value; });
    seedField.appendChild(seed);
    advancedBody.appendChild(seedField);

    var excluded = new Map();
    (state.bannedArtists || []).concat(state.autoExcluded || []).forEach(function (name) {
      excluded.set(name.toLowerCase(), name);
    });
    var banField = el("div", "hqm-field");
    banField.appendChild(el("label", "hqm-label", "Artistes exclus"));
    var banRow = el("div", "hqm-row");
    excluded.forEach(function (name, key) {
      var auto = (state.autoExcluded || []).some(function (item) { return item.toLowerCase() === key; });
      banRow.appendChild(btn("Annuler · " + name + (auto ? " (auto)" : ""), "hqm-chip", function () {
        updateTaste({ unban: name }).then(render).catch(function (e) { status(e.message, true); });
      }));
    });
    if (!excluded.size) banRow.appendChild(el("p", "hqm-muted", "Aucun artiste exclu."));
    banField.appendChild(banRow);
    var banInput = document.createElement("input");
    banInput.type = "text";
    banInput.placeholder = "Nom d’artiste à bannir";
    banInput.setAttribute("aria-label", "Artiste à bannir");
    banField.appendChild(banInput);
    banField.appendChild(btn("Bannir", "hqm-btn secondary", function () {
      if (!banInput.value.trim()) return;
      updateTaste({ ban: banInput.value.trim() }).then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    advancedBody.appendChild(banField);
    advanced.appendChild(advancedBody);
    settings.appendChild(advanced);
    host.appendChild(settings);

    var presets = el("section", "hqm-card");
    presets.appendChild(el("h3", "", "Préréglages"));
    var presetRow = el("div", "hqm-preset-row");
    (state.presets || []).forEach(function (preset) {
      presetRow.appendChild(btn(preset.name || preset.id, "hqm-chip", function () {
        if (preset.config) state.mixerConfig = Object.assign({}, state.mixerConfig, preset.config, { seed: "" });
        if (Array.isArray(preset.sources) && preset.sources.length) {
          state.mixerSources = preset.sources.map(function (source) {
            return {
              id: source.playlist_id || source.id,
              name: source.name || source.id,
              weight: source.weight || 1
            };
          }).filter(function (source) { return source.id; });
        }
        render();
        status("Préréglage chargé : " + (preset.name || preset.id));
      }));
    });
    if (!(state.presets || []).length) presetRow.appendChild(el("p", "hqm-muted", "Aucun préréglage."));
    presets.appendChild(presetRow);
    var savePreset = el("details", "hqm-edit");
    var saveSummary = document.createElement("summary");
    saveSummary.textContent = "Sauver la configuration actuelle";
    savePreset.appendChild(saveSummary);
    var saveBody = el("div", "hqm-edit-body");
    var saveName = document.createElement("input");
    saveName.type = "text";
    saveName.placeholder = "Nom du préréglage";
    saveName.setAttribute("aria-label", "Nom du préréglage");
    saveBody.appendChild(saveName);
    saveBody.appendChild(btn("Sauver", "hqm-btn secondary", function () {
      var name = saveName.value.trim() || "Personnalisé";
      call("/api/music/presets", "POST", {
        op: "upsert",
        preset: {
          id: name.toLowerCase().replace(/\s+/g, "-").slice(0, 40),
          name: name,
          sources: state.mixerSources,
          config: state.mixerConfig
        }
      }).then(loadMixerData).then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    savePreset.appendChild(saveBody);
    presets.appendChild(savePreset);
    host.appendChild(presets);

    if (state.session && state.session.tracks) {
      var preview = el("section", "hqm-card");
      var previewHead = el("div", "hqm-card-head");
      previewHead.appendChild(el("h3", "", "Aperçu de la session"));
      previewHead.appendChild(btn("Demander à Musica", "hqm-btn secondary", function () {
        setTab("musica");
        sendMusica("Explique cette session du Mixer.", "mixer_session").catch(function () {});
      }));
      preview.appendChild(previewHead);
      preview.appendChild(el("p", "hqm-muted", "Graine " +
        (state.session.seed != null ? state.session.seed : "—") + " · " +
        (state.session.tracks || []).length + " titres"));
      var stats = state.session.stats || {};
      if ((stats.sources || []).length) {
        preview.appendChild(el("p", "hqm-muted", "Répartition : " + stats.sources.map(function (source) {
          return (source.name || source.id) + " " + Math.round((source.picked_share || 0) * 100) + " %";
        }).join(" · ")));
      }
      if ((state.session.compromises || []).length) {
        preview.appendChild(el("p", "hqm-muted", "Compromis : " + state.session.compromises.join(" · ")));
      }
      var list = el("ul", "hqm-list");
      state.session.tracks.forEach(function (track, index) {
        var li = el("li", "");
        var info = el("div", "hqm-track-meta");
        info.appendChild(el("strong", "", (track.position || index + 1) + ". " + (track.name || "?") +
          (track.energy ? "  " + "⚡".repeat(track.energy) : "")));
        info.appendChild(el("span", "", (track.artists || []).join(", ") + (track.source_name ? " · " + track.source_name : "")));
        if (track.reason) info.appendChild(el("span", "hqm-reason", track.reason));
        li.appendChild(info);
        var actions = el("div", "hqm-row");
        actions.appendChild(iconBtn("Lire " + (track.name || "ce titre"), "play", function () {
          playerAction("play", { uris: [track.uri] })
            .catch(function (e) { status(friendlyPlayerError(e), true); });
        }));
        actions.appendChild(menuButton("Actions pour " + (track.name || "ce titre"), [
          { label: "Bannir l’artiste", run: function () {
            var artist = (track.artists || [])[0];
            if (!artist) return;
            updateTaste({ ban: artist }).then(function () {
              status("Artiste banni. Régénère la session pour l’appliquer.");
              render();
            }).catch(function (e) { status(e.message, true); });
          } },
          { label: "Retirer de la session", danger: true, run: function () {
            state.session.tracks.splice(index, 1);
            state.session.tracks.forEach(function (row, i) { row.position = i + 1; });
            render();
          } }
        ], "is-inline"));
        li.appendChild(actions);
        list.appendChild(li);
      });
      preview.appendChild(list);
      host.appendChild(preview);
    }
  }

  function renderDiscoveries(host) {
    if (state.deck && state.deck.open) renderDeck(host);
    renderRadar(host);

    var prefs = el("details", "hqm-card hqm-settings");
    var summary = document.createElement("summary");
    summary.textContent = "Réglages des découvertes";
    prefs.appendChild(summary);
    var body = el("div", "hqm-settings-body");
    var profile = state.profile || {};
    function listField(key, label) {
      var field = el("div", "hqm-field");
      field.appendChild(el("label", "hqm-label", label));
      var input = document.createElement("input");
      input.type = "text";
      input.value = (profile[key] || []).join(", ");
      input.setAttribute("data-hqm-pref", key);
      field.appendChild(input);
      return field;
    }
    body.appendChild(listField("favorite_artists", "Artistes favoris (séparés par des virgules)"));
    body.appendChild(listField("preferred_genres", "Genres préférés (séparés par des virgules)"));
    body.appendChild(listField("musical_patterns", "Motifs musicaux (séparés par des virgules)"));
    body.appendChild(btn("Enregistrer les préférences", "hqm-btn secondary", function () {
      var payload = {};
      prefs.querySelectorAll("[data-hqm-pref]").forEach(function (input) {
        payload[input.getAttribute("data-hqm-pref")] = input.value.split(",")
          .map(function (value) { return value.trim(); }).filter(Boolean);
      });
      call("/api/music/profile", "POST", payload)
        .then(loadDiscoveries)
        .then(function () { status("Préférences enregistrées."); render(); })
        .catch(function (e) { status(e.message, true); });
    }));

    var suggestion = state.discoveryQuery || {};
    body.appendChild(el("p", "hqm-muted", suggestion.ready
      ? "Requête suggérée : " + suggestion.query
      : "Ajoute un artiste ou un genre pour obtenir une requête de découverte."));

    var importBox = document.createElement("details");
    importBox.className = "hqm-advanced";
    var importSummary = document.createElement("summary");
    importSummary.textContent = "Importer une découverte";
    importBox.appendChild(importSummary);
    var importBody = el("div", "hqm-advanced-body");
    var title = document.createElement("input");
    title.placeholder = "Titre";
    title.setAttribute("aria-label", "Titre de la découverte");
    var artist = document.createElement("input");
    artist.placeholder = "Artiste";
    artist.setAttribute("aria-label", "Artiste de la découverte");
    var url = document.createElement("input");
    url.placeholder = "https://…";
    url.setAttribute("aria-label", "Lien vers la découverte");
    importBody.append(title, artist, url);
    importBody.appendChild(btn("Ajouter", "hqm-btn secondary", function () {
      call("/api/music/discoveries", "POST", {
        items: [{ title: title.value, artist: artist.value, source_url: url.value, confidence: 0.7 }]
      }).then(loadDiscoveries).then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    importBox.appendChild(importBody);
    body.appendChild(importBox);
    prefs.appendChild(body);
    host.appendChild(prefs);
  }

  function stopStudioPoll() {
    if (state.studioTimer) clearInterval(state.studioTimer);
    state.studioTimer = null;
  }

  async function refreshStudio() {
    if (!state.host || !state.shown || state.tab !== "studio") return;
    var target = state.host.querySelector("[data-studio-jobs]");
    if (!target) return;
    try {
      var results = await Promise.all([call("/api/music/studio"), call("/api/music/studio/gifts")]);
      var data = results[0], giftState = results[1].gift;
      var giftInfo = state.host && state.host.querySelector("[data-gift-status]");
      var giftToggle = state.host && state.host.querySelector("[data-gift-enabled]");
      if (giftToggle) giftToggle.checked = giftState.enabled !== false;
      if (giftInfo) {
        var messages = {drafting:"Musica imagine ton cadeau…", generating:"Musica crée ton morceau…", ready:"Un cadeau est prêt dans les créations ci-dessous.", failed:"Cadeau non créé : " + (giftState.error || "réessaie plus tard."), idle:"Musica peut préparer un cadeau de temps en temps."};
        giftInfo.textContent = messages[giftState.state] || messages.idle;
      }
      if (!state.host || state.tab !== "studio" || !target.isConnected) return;
      // Do not interrupt audio playback on a status poll.
      var signature = JSON.stringify(data.jobs || []);
      if (target.dataset.signature === signature) return;
      if (Array.from(target.querySelectorAll("audio")).some(function (audio) { return !audio.paused && !audio.ended; })) return;
      target.dataset.signature = signature;
      target.replaceChildren();
      (data.jobs || []).forEach(function (job) {
        target.appendChild(renderStudioJob(job));
      });
      if (!(data.jobs || []).length) target.appendChild(el("p", "hqm-muted", "Aucune création pour le moment."));
    } catch (err) { status(err.message, true); }
  }

  function renderStudio(host) {
    var create = el("section", "hqm-card hqm-studio");
    create.appendChild(el("h3", "", "Créer un morceau"));
    create.appendChild(el("p", "hqm-muted",
      "La génération tourne sur ton PC. Décris un style ; ajoute des paroles si tu veux, sinon le morceau sera instrumental."));

    var form = document.createElement("form");
    function field(label, name, type, max) {
      var wrap = document.createElement("label");
      wrap.textContent = label;
      var input = document.createElement(type === "textarea" ? "textarea" : "input");
      if (type !== "textarea") input.type = type;
      input.name = name;
      input.value = state.studioDraft[name];
      if (max) input.maxLength = max;
      input.addEventListener("input", function () { state.studioDraft[name] = input.value; });
      wrap.appendChild(input);
      form.appendChild(wrap);
      return input;
    }
    var prompt = field("Style musical", "prompt", "textarea", 512);
    prompt.required = true;
    prompt.rows = 3;
    prompt.placeholder = "Industrial metal, female vocals, double-kick drums, dark synths, melodic chorus.";
    var lyrics = field("Paroles (vide pour instrumental)", "lyrics", "textarea", 4096);
    lyrics.rows = 4;

    var advanced = el("details", "hqm-advanced");
    var advancedSummary = document.createElement("summary");
    advancedSummary.textContent = "Réglages avancés";
    advanced.appendChild(advancedSummary);
    var advancedBody = el("div", "hqm-advanced-body");
    var seedLabel = el("label", "", "Seed");
    var seed = document.createElement("input");
    seed.type = "number";
    seed.min = "0";
    seed.max = "2147483647";
    seed.value = state.studioDraft.seed;
    seed.addEventListener("input", function () { state.studioDraft.seed = seed.value; });
    seedLabel.appendChild(seed);
    advancedBody.appendChild(seedLabel);
    var durationLabel = el("label", "", "Durée en secondes");
    var duration = document.createElement("input");
    duration.type = "number";
    duration.min = "10";
    duration.max = "120";
    duration.value = state.studioDraft.duration;
    duration.addEventListener("input", function () { state.studioDraft.duration = duration.value; });
    durationLabel.appendChild(duration);
    advancedBody.appendChild(durationLabel);
    var bpmLabel = el("label", "", "Tempo BPM (facultatif)");
    var bpm = document.createElement("input");
    bpm.type = "number";
    bpm.min = "30";
    bpm.max = "300";
    bpm.value = state.studioDraft.bpm;
    bpm.addEventListener("input", function () { state.studioDraft.bpm = bpm.value; });
    bpmLabel.appendChild(bpm);
    advancedBody.appendChild(bpmLabel);
    var langLabel = el("label", "", "Langue des voix");
    var lang = document.createElement("select");
    [["en", "Anglais"], ["fr", "Français"], ["unknown", "Autre / automatique"]].forEach(function (pair) {
      var option = document.createElement("option");
      option.value = pair[0];
      option.textContent = pair[1];
      lang.appendChild(option);
    });
    lang.value = state.studioDraft.language;
    lang.addEventListener("change", function () { state.studioDraft.language = lang.value; });
    langLabel.appendChild(lang);
    advancedBody.appendChild(langLabel);
    advanced.appendChild(advancedBody);
    form.appendChild(advanced);
    var variantsLabel = el("label", "hqm-variants-field", "Variantes à comparer");
    var variants = document.createElement("select");
    [["1", "1 version"], ["2", "2 versions (A/B)"], ["3", "3 versions (A/B/C)"]].forEach(function (pair) {
      variants.appendChild(new Option(pair[1], pair[0]));
    });
    variants.value = state.studioDraft.variants || "1";
    variants.addEventListener("change", function () { state.studioDraft.variants = variants.value; });
    variantsLabel.appendChild(variants);
    form.appendChild(variantsLabel);
    renderLyricsHelper(form, prompt, lyrics, lang, duration);

    var submit = btn("Générer", "hqm-btn");
    submit.type = "submit";
    form.appendChild(submit);
    form.addEventListener("submit", async function (event) {
      event.preventDefault();
      submit.disabled = true;
      try {
        await call("/api/music/studio/generate", "POST", {
          prompt: prompt.value,
          lyrics: lyrics.value,
          seed: Number(seed.value) || Math.floor(Math.random() * 2147483647),
          duration: Number(duration.value) || 90,
          bpm: bpm.value ? Number(bpm.value) : null,
          language: lang.value,
          variants: Number(variants.value) || 1
        });
        status("Génération lancée.");
        await refreshStudio();
      } catch (err) {
        status(err.message, true);
      } finally {
        submit.disabled = false;
      }
    });
    create.appendChild(form);
    host.appendChild(create);

    var gifts = el("section", "hqm-card");
    gifts.appendChild(el("h3", "", "Les cadeaux de Musica"));
    gifts.appendChild(el("p", "hqm-muted",
      "Musica imagine parfois un morceau à partir de ton profil. Un cadeau par semaine au maximum, quand le PC est disponible."));
    var giftBox = el("div", "hqm-gifts");
    var toggleLabel = document.createElement("label");
    toggleLabel.className = "hqm-check";
    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.setAttribute("data-gift-enabled", "");
    toggleLabel.append(toggle, " Autoriser les cadeaux spontanés");
    toggle.addEventListener("change", async function () {
      toggle.disabled = true;
      try {
        await call("/api/music/studio/gifts/settings", "POST", { enabled: toggle.checked });
        await refreshStudio();
      } catch (err) {
        toggle.checked = !toggle.checked;
        status(err.message, true);
      } finally {
        toggle.disabled = false;
      }
    });
    giftBox.appendChild(toggleLabel);
    var giftStatus = el("p", "hqm-muted", "Chargement…");
    giftStatus.setAttribute("data-gift-status", "");
    giftBox.appendChild(giftStatus);
    giftBox.appendChild(btn("Demander un cadeau", "hqm-btn secondary", async function () {
      try {
        await call("/api/music/studio/gift", "POST", {});
        status("Musica prépare ton cadeau.");
        await refreshStudio();
      } catch (err) {
        status(err.message, true);
      }
    }));
    gifts.appendChild(giftBox);
    host.appendChild(gifts);

    var creations = el("section", "hqm-card");
    creations.appendChild(el("h3", "", "Créations"));
    var jobs = el("div", "hqm-studio-jobs");
    jobs.setAttribute("data-studio-jobs", "");
    creations.appendChild(jobs);
    host.appendChild(creations);
  }

  /* ---------- Salon extras: DJ Musica, minuteur, teinte, journal, quiz, swipe, artiste, humeur, Studio remix ---------- */

  var DJ_KEY = "hqm_dj";
  var FADE_MS = 60000;
  var WEEKDAYS = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
  var WEEKDAYS_LONG = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

  function loadDj() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(DJ_KEY) || "null"); } catch (_e) {}
    saved = saved || {};
    state.dj = {
      on: saved.on === true,
      every: [1, 2, 3, 5].indexOf(saved.every) >= 0 ? saved.every : 3,
      style: ["annonce", "anecdote", "transition"].indexOf(saved.style) >= 0 ? saved.style : "annonce"
    };
  }

  function saveDj() {
    try { localStorage.setItem(DJ_KEY, JSON.stringify(state.dj)); } catch (_e) {}
  }

  function blindMasking() {
    var cur = state.djShow && state.djShow.duels && state.djShow.duels.current;
    var blind = !!(cur && cur.blind && !cur.vote);
    // The Musica chip reads this one flag: no bubble may name the song while a tournament match or a quiz round is concealed.
    var hidden = blind || quizMasking();
    var was = !!window.__hqBlindMatch;
    window.__hqBlindMatch = hidden;
    if (hidden && !was) {
      try { window.dispatchEvent(new CustomEvent("hq:musica-conceal")); } catch (_e) {}
    }
    return blind;
  }

  /* Her live reaction also appears as a bubble on the Musica chip (it listens for this event). */
  /* Screen-reader announcement (polite live region): what changed on screen that a sighted user just sees. */
  function announce(text) {
    if (!text) return;
    state.announcement = String(text);
    var node = state.host && state.host.querySelector("[data-hqm='announcer']");
    if (node) {
      node.textContent = "";  // clear first so a repeated sentence is announced again
      setTimeout(function () { node.textContent = state.announcement; }, 30);
    }
  }

  /* Send the verdict or listening state to the chip's motion controller. */
  function musicaReact(kind) {
    try { window.dispatchEvent(new CustomEvent("hq:musica-react", { detail: { kind: kind } })); } catch (_e) {}
  }

  function musicaSay(text, quietFace) {
    if (!text) return;
    announce("Musica : " + text);  // the bubble is visual only; the live region carries it for screen readers
    try { window.dispatchEvent(new CustomEvent("hq:musica-say", { detail: { text: String(text), quietFace: !!quietFace } })); } catch (_e) {}
  }

  function quizMasking() {
    return !!(state.quiz && state.quiz.game && !state.quiz.game.done && !state.quiz.revealed);
  }

  function onTrackChange(next, previousMs) {
    var item = next && next.item;
    if (!item || !item.uri || state.lastTrackUri === item.uri) return;
    var previous = state.lastTrackItem;
    state.lastTrackUri = item.uri;
    state.lastTrackItem = item;
    if (!previous) return; // first observation after load: nothing changed for the listener
    if (state.tab === "lecture") refreshQueueCard();
    var show = state.djShow;
    if (show && show.active && !(show.station && show.station.running)) {
      var ctx = (next.raw_context || next.context || {}).uri || null;
      call("/api/musica/dj/observe", "POST", { uri: item.uri, previous_uri: previous.uri, previous_ms: previousMs, context: ctx })
        .then(function (answer) {
          if (answer.left || answer.segment_start) loadDjShow().then(paintDjCard).catch(function () {});
          if (answer.left) status("DJ Musica s’efface : tu as lancé autre chose.");
          if (answer.rescue) { status("Je te ramène à mon prochain segment…"); watchAwaiting(); }
          else paintDjCard();
          if (quizMasking() || state.sleep) return;
          if (answer.reaction) { musicaSay(answer.reaction.text); announce("Musica : " + answer.reaction.text); }  // a skip or a bet; voiced when its drop was cached
          if (answer.voice_first) introAtBoundary(answer).catch(function () {});
          else playDrops(answer.drops || [], answer.text, !!answer.segment_start).catch(function () {});
        }).catch(function () {});
      return;
    }
    if (!state.dj || !state.dj.on || !next.playing || quizMasking() || state.speakingMusica || state.sleep) return;
    state.djCount = (state.djCount || 0) + 1;
    if (state.djCount % state.dj.every !== 0) return;
    djAnnounce(item, previous).catch(function () {});
  }

  async function djAnnounce(item, previous) {
    var data = await call("/api/musica/dj", "POST", {
      track: item.name || "",
      artist: (item.artists || []).join(", "),
      album: item.album || "",
      uri: item.uri,
      previous: previous ? (previous.name || "") + " — " + (previous.artists || []).join(", ") : "",
      style: state.dj.style,
      language: state.voiceLanguage === "en" ? "en" : "fr"
    });
    if (!data || !data.line) return;
    state.djLast = { text: data.line, at: Date.now() };
    paintDjLine();
    await speakMusica(data.line);
  }

  function paintDjLine() {
    if (!state.host) return;
    var fresh = state.djLast && Date.now() - state.djLast.at < 20000;
    state.host.querySelectorAll("[data-hqm='dj-line']").forEach(function (node) {
      node.textContent = fresh ? "🎙 " + state.djLast.text : "";
      node.hidden = !fresh;
    });
    if (fresh) {
      clearTimeout(state.djLineTimer);
      state.djLineTimer = setTimeout(paintDjLine, 20500);
    }
  }

  /* During a show, look at the player again right after the current track should end, so her line lands
     on the change instead of up to one poll (3 s, or 10 s in the background) later. */
  function scheduleBoundaryCheck(player) {
    clearTimeout(state.boundaryTimer);
    var show = state.djShow;
    if (!show || !show.active || (show.station && show.station.running)) return;
    var item = player && player.item;
    if (!item || !player.playing || !item.duration_ms) return;
    var remaining = item.duration_ms - (Number(player.progress_ms) || 0);
    if (remaining <= 0 || remaining > 15 * 60 * 1000) return;
    state.boundaryTimer = setTimeout(function () {
      refreshPlayer(true).catch(function () {});
      setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 1500); // Spotify can lag a moment
    }, remaining + 350);
  }

  async function rampVolume(deviceId, from, to, ms, steps) {
    for (var i = 1; i <= steps; i += 1) {
      await setVolume(deviceId, from + (to - from) * i / steps).catch(function () {});
      if (i < steps) await new Promise(function (resolve) { setTimeout(resolve, ms / steps); });
    }
  }

  /* Plays prepared drops (jingle + voice already mixed on the server) with Spotify ducked. */
  async function playDrops(drops, text, fallbackSpeech) {
    var onAir = state.djShow && state.djShow.segment;
    if (text && onAir && onAir.show === "duel" && !state.cameoSaying) musicaSay(text);  // match intros and « line_b » show on the chip too
    if (text) {
      state.djLast = { text: text, at: Date.now() };
      paintDjLine();
    }
    if (state.speakingMusica) return;
    if (!drops.length) {
      if (fallbackSpeech && text) await speakMusica(text);
      return;
    }
    state.speakingMusica = true;
    var ducked = null;
    try {
      var player = await call("/api/spotify/player").catch(function () { return null; });
      var device = player && player.playing && player.device;
      if (device && device.id && Number.isFinite(device.volume_percent) && device.volume_percent > 10) {
        ducked = device;
        await rampVolume(device.id, device.volume_percent, Math.max(5, Math.round(device.volume_percent * 0.35)), 450, 3);
      }
      for (var i = 0; i < drops.length; i += 1) {
        try {
          await playSpeech("/api/musica/dj/audio/" + encodeURIComponent(drops[i]));
        } catch (err) {
          if (err && err.name === "NotAllowedError") {
            state.pendingDrops = { drops: drops.slice(i), text: text };
            status("🔊 Le navigateur a bloqué la voix de Musica — touche l’écran pour l’entendre.", true);
            break;
          }
        }
      }
    } finally {
      state.speakingMusica = false;
      if (ducked) await rampVolume(ducked.id, Math.max(5, Math.round(ducked.volume_percent * 0.35)), ducked.volume_percent, 800, 4);
    }
  }

  async function loadDjShow() {
    state.djShow = await call("/api/musica/dj/state");
    if (state.djShow.prep && state.djShow.prep.running) watchPrep();
    else if (state.djShow.awaiting) introThenGo(state.djShow.awaiting, state.djShow);
    syncDjWatch();
    return state.djShow;
  }

  /* The Lecture poll stops when Musique is hidden; while a show is on air (and no PC station drives it),
     keep reading the player every 10 s so track changes still reach the DJ and the next segment gets queued. */
  function syncDjWatch() {
    var show = state.djShow;
    var need = !!(state.host && show && show.active && !(show.station && show.station.running));
    if (need && !state.djWatch) {
      state.djWatch = setInterval(function () {
        if (!state.host) return;
        if (state.shown && !document.hidden && state.pollTimer) return; // the normal 3 s poll is running
        refreshPlayer(true).catch(function () {});
      }, 10000);
    } else if (!need && state.djWatch) {
      clearInterval(state.djWatch);
      state.djWatch = null;
    }
  }

  function prepNextPct(prep) {
    var stages = prep.stages || [];
    for (var i = 0; i < stages.length; i += 1) if (stages[i].pct > prep.pct) return stages[i].pct;
    return 100;
  }

  function renderDjProgress(prep) {
    var box = el("div", "hqm-dj-progress");
    box.setAttribute("data-hqm", "dj-progress");
    var top = el("div", "hqm-dj-progress-top");
    var label = el("span", "hqm-dj-progress-label", prep.label || "Préparation…");
    label.setAttribute("data-hqm", "dj-progress-label");
    label.setAttribute("aria-live", "polite");
    var shown = Math.max(prep.pct || 0, state.prepDisplay || 0);
    var pct = el("span", "hqm-dj-progress-pct", Math.round(shown) + " %");
    pct.setAttribute("data-hqm", "dj-progress-pct");
    top.append(label, pct);
    box.appendChild(top);
    var bar = el("div", "hqm-dj-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Préparation de l’émission");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(Math.round(shown)));
    var fill = el("span", "hqm-dj-bar-fill");
    fill.setAttribute("data-hqm", "dj-progress-fill");
    fill.style.width = shown + "%";
    bar.appendChild(fill);
    box.appendChild(bar);
    var steps = el("ol", "hqm-dj-steps");
    var names = { pools: "Fouille", writing: "Écriture", voice: "Micro", play: "Antenne" };
    var reached = true;
    (prep.stages || []).forEach(function (stage) {
      if (!names[stage.key]) return;
      var current = stage.key === prep.stage;
      var li = el("li", current ? "is-current" : reached ? "is-done" : "");
      if (current) reached = false;
      li.appendChild(el("span", "hqm-dj-step-dot"));
      li.appendChild(el("span", "", names[stage.key]));
      steps.appendChild(li);
    });
    box.appendChild(steps);
    box.appendChild(el("p", "hqm-muted hqm-hint", "Ça prend en général 10 à 30 secondes. Tu peux continuer à naviguer."));
    return box;
  }

  function paintPrepBar(prep) {
    if (!state.host) return;
    var shown = Math.max(prep.pct || 0, state.prepDisplay || 0);
    var fill = state.host.querySelector("[data-hqm='dj-progress-fill']");
    var pct = state.host.querySelector("[data-hqm='dj-progress-pct']");
    var bar = fill && fill.parentNode;
    if (fill) fill.style.width = shown + "%";
    if (pct) pct.textContent = Math.round(shown) + " %";
    if (bar) bar.setAttribute("aria-valuenow", String(Math.round(shown)));
  }

  function watchPrep() {
    if (state.prepTimer) return;
    state.prepTimer = setInterval(async function () {
      var data;
      try { data = await call("/api/musica/dj/state"); } catch (_e) { return; }
      var previous = state.djShow && state.djShow.prep;
      state.djShow = data;
      var prep = data.prep;
      if (prep && prep.running) {
        state.prepDisplay = Math.max(prep.pct, Math.min(prepNextPct(prep) - 3, (state.prepDisplay || 0) + 0.7));
        if (!previous || previous.stage !== prep.stage || !state.host || !state.host.querySelector("[data-hqm='dj-progress']")) paintDjCard();
        else paintPrepBar(prep);
        return;
      }
      clearInterval(state.prepTimer);
      state.prepTimer = null;
      state.prepDisplay = 0;
      if (prep && prep.error) {
        status(prep.error, true);
        paintDjCard();
        return;
      }
      finishPrep(data);
    }, 600);
  }

  function finishPrep(data) {
    var prep = data.prep || {};
    paintDjCard();
    if (!prep.id || state.prepHandled === prep.id) return;
    state.prepHandled = prep.id;
    if (data.language) state.voiceLanguage = data.language; // browser-speech fallback speaks the same language
    status("En ondes : " + (data.segment ? data.segment.title : "DJ Musica"));
    if (data.awaiting) introThenGo(data.awaiting, data);
  }

  /* Her voice first, then the music: play the intro (music is paused), then ask the server to start the segment. */
  async function introThenGo(awaiting, show) {
    if (!awaiting || state.introHandled === awaiting.segment_id) return;
    state.introHandled = awaiting.segment_id;
    show = show || state.djShow || {};
    if (show.station && show.station.running) return; // the PC station speaks and starts the music itself
    if ((awaiting.drops || []).length || awaiting.text) {
      await playDrops(awaiting.drops || [], awaiting.text, true).catch(function () {});
    }
    // If the browser blocked her voice, start the music anyway; the next tap plays what was missed.
    var data = await call("/api/musica/dj/go", "POST", { segment_id: awaiting.segment_id }).catch(function (err) {
      status(friendlyPlayerError(err), true);
      return null;
    });
    if (data) {
      state.djShow = data;
      var first = data.segment && data.segment.tracks[0];
      if (first) { state.lastTrackUri = first.uri; state.lastTrackItem = { uri: first.uri, name: first.name, artists: first.artists }; }
      if (data.playback && data.playback.playing === false) {
        status(friendlyPlayerError({ code: data.playback.code, message: data.playback.error }), true);
      }
      paintDjCard();
    }
    setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 900);
  }

  /* The playlist flowed into her next segment: pause, let her introduce it, then the song from its start. */
  async function introAtBoundary(answer) {
    var paused = false;
    try {
      await playerAction("pause", { auto_device: false }, { skipRefresh: true });
      paused = true;
    } catch (_e) {}
    await playDrops(answer.drops || [], answer.text, true).catch(function () {});
    if (paused) {
      await playerAction("seek", { position_ms: 0, auto_device: false }, { skipRefresh: true }).catch(function () {});
      await playerAction("play", { auto_device: false }, { skipRefresh: true }).catch(function () {});
    }
    setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 900);
  }

  /* After « Segment suivant » (when not ready yet) or an autoplay rescue, wait for her next intro. */
  function watchAwaiting() {
    if (state.awaitTimer) return;
    var until = Date.now() + 90000;
    state.awaitTimer = setInterval(async function () {
      var data = await call("/api/musica/dj/state").catch(function () { return null; });
      if (data) state.djShow = data;
      if ((data && data.awaiting) || Date.now() > until || !(data && data.active)) {
        clearInterval(state.awaitTimer);
        state.awaitTimer = null;
        paintDjCard();
        if (data && data.awaiting) introThenGo(data.awaiting, data);
      }
    }, 1000);
  }

  async function djStart(body) {
    unlockAudio(); // still inside the click: unlock sound for the drops that will start on their own
    state.prepDisplay = 2;
    var data = await call("/api/musica/dj/start", "POST", Object.assign({ device_id: state.preferredDeviceId || undefined }, body));
    state.djShow = data;
    paintDjCard();
    watchPrep();
    return data;
  }

  async function djSteer(body) {
    unlockAudio();
    state.prepDisplay = 2;
    var data = await call("/api/musica/dj/steer", "POST", Object.assign({ device_id: state.preferredDeviceId || undefined }, body));
    state.djShow = data;
    paintDjCard();
    watchPrep();
    return data;
  }

  function paintDjCard() {
    paintDailyDot();
    if (state.host) {
      var wasBlind = state.host.classList.contains("hqm-quiz-masked") && !quizMasking();
      state.host.classList.toggle("hqm-quiz-masked", quizMasking() || blindMasking());
      if (blindMasking() && !wasBlind) refreshQueueCard();  // a blind match just opened: hide the queue names
    }
    var slot = state.host && state.host.querySelector("[data-hqm='dj-card']");
    paintStrip();
    if (!slot) {
      if (state.host && state.tab === "quiz") render(); // the tournament lives in the Quiz tab
      return;
    }
    var open = Array.prototype.map.call(slot.querySelectorAll("details[open]"), function (d) { return d.className; });
    var fresh = renderDjCard();
    open.forEach(function (cls) {
      var match = fresh.querySelector("details." + cls.trim().split(/\s+/).join("."));
      if (match) match.open = true;
    });
    slot.replaceWith(fresh);
    paintDockBadges();
    syncDjWatch();
  }

  /* What the Fouille dug up for this segment: every source with its haul, and what reached her shortlist. */
  function djDigSummary(dig) {
    var labels = dig.labels || {};
    var focusNames = { nostalgie: "nostalgie", decouverte: "découvertes", nouveautes: "nouveautés", change: "changement d’ambiance" };
    var box = document.createElement("details");
    box.className = "hqm-dj-dig";
    var found = dig.found || {};
    var offered = dig.offered || {};
    var keys = Object.keys(found).sort(function (a, b) { return found[b] - found[a]; });
    var total = keys.reduce(function (sum, k) { return sum + found[k]; }, 0);
    var summary = document.createElement("summary");
    summary.textContent = "Fouille : " + total + " titres dans " + keys.length + " sources" +
      (dig.focus ? " · orientée " + (focusNames[dig.focus] || dig.focus) : "");
    box.appendChild(summary);
    var chips = el("div", "hqm-preset-row");
    keys.forEach(function (k) {
      chips.appendChild(el("span", "hqm-chip is-static" + (offered[k] ? " is-offered" : ""),
        (labels[k] || k) + " " + found[k] + (offered[k] ? " → " + offered[k] : "")));
    });
    box.appendChild(chips);
    if ((dig.web || []).length) box.appendChild(el("p", "hqm-muted", "Trouvé sur le web pour « " + dig.web.join(" · ") + " »" +
      ((dig.sites || []).length ? " — sites : " + dig.sites.join(", ") : "") + ". Chaque titre a été vérifié sur Spotify."));
    if ((dig.searches || []).length) box.appendChild(el("p", "hqm-muted", "Recherches Spotify écrites pour ta demande : " + dig.searches.join(" · ")));
    box.appendChild(el("p", "hqm-muted hqm-hint", "« → » : combien sont arrivés dans sa présélection (au plus deux titres par artiste, les titres passés à l’antenne ces quatre derniers jours se reposent)."));
    return box;
  }

  function djSegmentList(segment, label) {
    var box = el("div", "hqm-dj-segment");
    var head = el("div", "hqm-dj-segment-head");
    head.appendChild(el("span", "hqm-eyebrow", label));
    head.appendChild(el("strong", "", segment.title || "Segment"));
    box.appendChild(head);
    var list = el("ol", "hqm-dj-tracks");
    var current = state.player && state.player.item && state.player.item.uri;
    var factFor = {};
    (segment.facts || []).forEach(function (f) { factFor[f["for"]] = f.fact; });
    (segment.tracks || []).forEach(function (track, i) {
      var li = el("li", track.uri === current ? "is-current" : "");
      li.setAttribute("data-track-uri", track.uri);
      var meta = el("div", "hqm-track-meta");
      meta.appendChild(el("strong", "", track.name));
      meta.appendChild(el("span", "hqm-muted", (track.artists || []).join(", ")));
      var digLabels = (segment.dig && segment.dig.labels) || {};
      if (track.pool && digLabels[track.pool]) meta.appendChild(el("span", "hqm-dj-source", digLabels[track.pool]));
      if (track.why) meta.appendChild(el("span", "hqm-reason", track.why));
      if (track.pick) {
        var badge = el("span", "hqm-dj-pick" + (track.pick_result ? " is-" + track.pick_result : ""),
          track.pick_result === "won" ? "★ Pari de Musica · gagné" : track.pick_result === "lost" ? "★ Pari de Musica · perdu" : "★ Pari de Musica");
        meta.appendChild(badge);
      }
      var fact = factFor["t" + i] || (i === 0 && factFor.intro);
      if (track.fact || fact) meta.appendChild(el("span", "hqm-dj-fact", "✓ " + (fact || "Anecdote vérifiée sur le web")));
      li.appendChild(meta);
      list.appendChild(li);
    });
    box.appendChild(list);
    if (segment.dig) box.appendChild(djDigSummary(segment.dig));
    var sources = (segment.fact_sources || []).filter(function (s) { return /^https:\/\//.test(s.uri || ""); });
    if (sources.length) {
      var src = el("p", "hqm-muted hqm-dj-sources", "Sources : ");
      sources.slice(0, 4).forEach(function (s, i) {
        var a = el("a", "", s.title || "web");
        a.href = s.uri;
        a.target = "_blank";
        a.rel = "noopener noreferrer";
        if (i) src.appendChild(document.createTextNode(", "));
        src.appendChild(a);
      });
      box.appendChild(src);
    }
    return box;
  }

  /* ---- La station: programme de la semaine, « précédemment sur Musica », ce qu'elle sait de toi ---------------------- */

  var DAY_SHORT = ["L", "M", "M", "J", "V", "S", "D"];
  var DAY_FULL = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

  async function loadStation() {
    try { state.station = await call("/api/musica/dj/station"); state.stationError = false; }
    catch (_e) { state.stationError = true; }
    return state.station;
  }

  function stationWhen(row) {
    var at = new Date(row.ts * 1000);
    var time = ("0" + at.getHours()).slice(-2) + ":" + ("0" + at.getMinutes()).slice(-2);
    return (row.today ? "aujourd’hui" : DAY_FULL[(at.getDay() + 6) % 7]) + " " + time;
  }

  function repaintStation() {
    var slot = state.host && state.host.querySelector("[data-hqm='station-card']");
    if (slot) slot.replaceWith(renderStationCard());
  }

  function renderStationCard() {
    var st = state.station;
    var card = el("section", "hqm-card hqm-station");
    card.setAttribute("data-hqm", "station-card");
    var head = el("div", "hqm-card-head");
    head.appendChild(el("h3", "", "La station"));
    card.appendChild(head);
    if (!st) {
      card.appendChild(el("p", "hqm-muted" + (state.stationError ? "" : " hqm-loading"), state.stationError ? "Programme indisponible pour le moment." : "Chargement…"));
      if (!state.stationLoading && !state.stationError) {
        state.stationLoading = true;
        loadStation().then(function () { state.stationLoading = false; repaintStation(); });
      }
      return card;
    }
    var prev = st.previously || {};
    if (prev.line && ((prev.items || []).length || prev.first_visit) && !state.stationSeen) {
      var recap = el("div", "hqm-station-prev");
      recap.appendChild(el("span", "hqm-dj-label", "Précédemment sur Musica"));
      recap.appendChild(el("p", "", prev.line));
      recap.appendChild(btn("Compris", "hqm-btn secondary", function () {
        state.stationSeen = true;
        call("/api/musica/dj/station/seen", "POST", {}).then(function (d) { state.station = d; }).catch(function () {});
        repaintStation();
      }));
      card.appendChild(recap);
    }
    (st.ready || []).forEach(function (row) {
      var banner = el("div", "hqm-station-ready");
      banner.appendChild(el("strong", "", (st.kinds[row.kind] ? st.kinds[row.kind].icon + " " : "") + row.label + " est prête"));
      banner.appendChild(btn("Lancer", "hqm-btn", function () {
        unlockAudio();
        state.prepDisplay = 2;
        call("/api/musica/dj/station/launch", "POST", { id: row.id, device_id: state.preferredDeviceId || undefined }).then(function (data) {
          state.djShow = data;
          paintDjCard();
          watchPrep();
          return loadStation();
        }).then(repaintStation).catch(function (e) { status(e.message, true); });
      }));
      banner.appendChild(btn("Plus tard", "hqm-btn secondary", function () {
        call("/api/musica/dj/station/dismiss", "POST", { id: row.id }).then(function (d) { state.station = d; repaintStation(); }).catch(function () {});
      }));
      card.appendChild(banner);
    });
    var next = el("ol", "hqm-station-next");
    next.setAttribute("aria-label", "Prochaines émissions");
    (st.upcoming || []).forEach(function (row) {
      var li = el("li", "");
      li.appendChild(el("span", "hqm-station-icon", row.icon));
      li.appendChild(el("strong", "", row.label));
      li.appendChild(el("span", "hqm-muted", stationWhen(row) + (row.source === "settings" ? " · réglé dans les réglages de l’émission" : "")));
      next.appendChild(li);
    });
    if (!(st.upcoming || []).length) next.appendChild(el("li", "hqm-muted", "Aucune émission programmée."));
    card.appendChild(next);
    if (!(st.upcoming || []).length && !(st.slots || []).length) {
      var offer = el("div", "hqm-station-offer");
      offer.appendChild(el("p", "hqm-muted", "Je peux te proposer une semaine type : le défi du jour à 19 h, une soirée duel le vendredi, un tournoi le dimanche. Tu ajustes ensuite."));
      offer.appendChild(btn("Proposer une grille", "hqm-btn", function () {
        call("/api/musica/dj/station/grid", "POST", { suggested: true }).then(function (d) { state.station = d; repaintStation(); status("Grille proposée : ajuste-la quand tu veux."); })
          .catch(function (e) { status(e.message, true); });
      }));
      card.appendChild(offer);
    }
    card.appendChild(renderStationGrid(st));
    var moments = el("label", "hqm-station-moments");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = st.moments !== false;
    box.addEventListener("change", function () {
      call("/api/musica/dj/settings", "POST", { moments: box.checked }).then(function () {
        if (box.checked && window.HqMusicaMoments) window.HqMusicaMoments.enable();
        if (state.station) state.station.moments = box.checked;
        status(box.checked ? "Musica peut te faire signe hors de Musique." : "Plus de nudges hors de Musique.");
      }).catch(function (e) { box.checked = !box.checked; status(e.message, true); });
    });
    moments.appendChild(box);
    moments.appendChild(document.createTextNode(" Musica peut me faire signe ailleurs dans HQ (défi du jour, émission prête)"));
    card.appendChild(moments);
    card.appendChild(renderStationMemory());
    return card;
  }

  /* The weekly programme editor: one row per slot, saved as a whole. */
  function renderStationGrid(st) {
    var box = el("details", "hqm-advanced hqm-station-grid");
    var summary = document.createElement("summary");
    summary.textContent = "Programmer la semaine";
    box.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    box.appendChild(body);
    box.open = !!state.stationGridOpen;
    box.addEventListener("toggle", function () { state.stationGridOpen = box.open; });
    var draft = (st.slots || []).map(function (s) { return Object.assign({}, s, { days: (s.days || []).slice() }); });
    function saved(d) { state.station = d; state.stationGridOpen = true; repaintStation(); }
    function paint() {
      body.replaceChildren();
      if (!draft.length) {
        body.appendChild(el("p", "hqm-muted", "Aucun créneau. La matinale et le récap du dimanche se règlent dans les réglages de l’émission ; ici tu places duels, défis, tournois et émissions libres."));
        body.appendChild(btn("Proposer une grille", "hqm-btn", function () {
          call("/api/musica/dj/station/grid", "POST", { suggested: true }).then(saved).catch(function (e) { status(e.message, true); });
        }));
      }
      draft.forEach(function (slot, index) {
        var row = el("div", "hqm-station-slot" + (slot.enabled === false ? " is-off" : ""));
        var on = document.createElement("input");
        on.type = "checkbox";
        on.checked = slot.enabled !== false;
        on.setAttribute("aria-label", "Créneau actif");
        on.addEventListener("change", function () { slot.enabled = on.checked; row.classList.toggle("is-off", !on.checked); });
        var label = document.createElement("input");
        label.type = "text";
        label.maxLength = 40;
        label.value = slot.label;
        label.setAttribute("aria-label", "Nom du créneau");
        label.addEventListener("input", function () { slot.label = label.value; });
        var kind = document.createElement("select");
        kind.setAttribute("aria-label", "Type d’émission");
        Object.keys(st.kinds).forEach(function (k) { kind.appendChild(new Option(st.kinds[k].icon + " " + st.kinds[k].label, k)); });
        kind.value = slot.kind;
        kind.addEventListener("change", function () { slot.kind = kind.value; });
        var time = document.createElement("input");
        time.type = "time";
        time.value = slot.time;
        time.setAttribute("aria-label", "Heure");
        time.addEventListener("change", function () { if (time.value) slot.time = time.value; });
        var days = el("div", "hqm-station-days");
        days.setAttribute("role", "group");
        days.setAttribute("aria-label", "Jours");
        DAY_SHORT.forEach(function (letter, d) {
          var chip = btn(letter, "hqm-station-day" + (slot.days.indexOf(d) >= 0 ? " is-on" : ""), function () {
            var at = slot.days.indexOf(d);
            if (at >= 0) { if (slot.days.length > 1) slot.days.splice(at, 1); } else slot.days.push(d);
            chip.classList.toggle("is-on", slot.days.indexOf(d) >= 0);
            chip.setAttribute("aria-pressed", slot.days.indexOf(d) >= 0 ? "true" : "false");
          });
          chip.setAttribute("aria-label", DAY_FULL[d]);
          chip.setAttribute("aria-pressed", slot.days.indexOf(d) >= 0 ? "true" : "false");
          days.appendChild(chip);
        });
        var remove = btn("Retirer", "hqm-btn secondary", function () { draft.splice(index, 1); paint(); });
        [on, label, kind, time, days, remove].forEach(function (n) { row.appendChild(n); });
        body.appendChild(row);
      });
      var actions = el("div", "hqm-station-actions");
      if (draft.length < 14) actions.appendChild(btn("Ajouter un créneau", "hqm-btn secondary", function () {
        draft.push({ label: "Nouvelle émission", kind: "dj", days: [4], time: "20:00", enabled: true });
        paint();
      }));
      if (draft.length) actions.appendChild(btn("Enregistrer la grille", "hqm-btn", function () {
        call("/api/musica/dj/station/grid", "POST", { slots: draft }).then(function (d) { saved(d); status("Grille enregistrée."); })
          .catch(function (e) { status(e.message, true); });
      }));
      body.appendChild(actions);
    }
    paint();
    return box;
  }

  /* What she knows about his taste, with the safe corrections. */
  function renderStationMemory() {
    var box = el("details", "hqm-advanced hqm-station-memory");
    var summary = document.createElement("summary");
    summary.textContent = "Ce que Musica sait de tes goûts";
    box.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    box.appendChild(body);
    function paint(m) {
      body.replaceChildren();
      if (!m) { body.appendChild(el("p", "hqm-muted hqm-loading", "Je relis mes notes…")); return; }
      function artists(title, rows, ban) {
        if (!rows.length) return;
        body.appendChild(el("strong", "hqm-dj-label", title));
        var ul = el("ul", "hqm-station-artists");
        rows.forEach(function (r) {
          var li = el("li", "");
          li.appendChild(el("span", "", r.name));
          li.appendChild(btn(ban ? "Ne plus proposer" : "Réautoriser", "hqm-btn secondary", function () {
            call("/api/musica/dj/station/memory", "POST", ban ? { ban: r.name } : { unban: r.name }).then(function (d) {
              state.stationMemory = d;
              paint(d);
              status(ban ? r.name + " ne sera plus proposé." : r.name + " est de retour.");
            }).catch(function (e) { status(e.message, true); });
          }));
          ul.appendChild(li);
        });
        body.appendChild(ul);
      }
      artists("Elle te voit surtout écouter", m.loves || [], true);
      artists("Elle sent que tu t’en lasses", m.cooling || [], true);
      artists("Ne plus proposer", (m.banned || []).map(function (n) { return { name: n }; }), false);
      var facts = [];
      if ((m.finishes || []).length) facts.push("Tu écoutes jusqu’au bout : " + m.finishes.join(", ") + ".");
      if ((m.skips || []).length) facts.push("Tu zappes souvent : " + m.skips.join(", ") + ".");
      Object.keys(m.dayparts || {}).forEach(function (part) { facts.push("Le/la " + part + " : " + m.dayparts[part].join(", ") + "."); });
      if ((m.steers || []).length) facts.push("Tes dernières demandes : " + m.steers.join(" · ") + ".");
      if (m.duels && m.duels.played) facts.push("Ses pronostics : " + m.duels.right + " justes sur " + m.duels.played + " duels.");
      if (!m.history_sharing) facts.push("Le partage de ton historique est coupé : elle n’en tient pas compte.");
      facts.forEach(function (f) { body.appendChild(el("p", "hqm-muted", f)); });
      if (!facts.length && !(m.loves || []).length) body.appendChild(el("p", "hqm-muted", "Elle n’a pas encore assez d’écoutes pour te connaître : ça vient vite."));
      body.appendChild(btn("Repartir de zéro (ce qu’elle a appris en émission)", "hqm-btn secondary", function () {
        if (!window.confirm("Effacer ce que Musica a appris pendant les émissions ? Ton journal et tes likes restent.")) return;
        call("/api/musica/dj/learned/reset", "POST", {}).then(function () { return call("/api/musica/dj/station/memory"); })
          .then(function (d) { state.stationMemory = d; paint(d); status("C’est effacé : elle réapprend."); }).catch(function (e) { status(e.message, true); });
      }));
    }
    box.addEventListener("toggle", function () {
      if (!box.open) return;
      paint(state.stationMemory || null);
      call("/api/musica/dj/station/memory").then(function (d) { state.stationMemory = d; paint(d); }).catch(function () {
        body.replaceChildren(el("p", "hqm-muted", "Mémoire indisponible pour le moment."));
      });
    });
    return box;
  }

  function renderDjCard() {
    var show = state.djShow || {};
    var st = show.settings || {};
    var prep = show.prep && show.prep.running ? show.prep : null;
    var live = !!show.active;
    var card = el("section", "hqm-card hqm-dj-show" + (live ? " is-live" : "") + (prep ? " is-preparing" : ""));
    card.setAttribute("data-hqm", "dj-card");

    var hero = el("div", "hqm-dj-hero");
    var eq = el("div", "hqm-dj-eq");
    eq.setAttribute("aria-hidden", "true");
    for (var b = 0; b < 5; b += 1) eq.appendChild(el("i"));
    hero.appendChild(eq);
    var titles = el("div", "hqm-dj-titles");
    titles.appendChild(el("span", "hqm-dj-kicker", live ? "On air" : prep ? "En préparation" : "Radio Musica"));
    titles.appendChild(el("h3", "hqm-dj-name", "DJ Musica"));
    titles.appendChild(el("p", "hqm-dj-tagline", live
      ? (show.segment ? show.segment.title + (show.segment.theme ? " · " + show.segment.theme : "") : "En ondes")
      : prep ? "Musica prépare ton émission…"
        : "Ton émission perso : ton journal, le radar et tes goûts, avec sa voix entre les titres."));
    hero.appendChild(titles);
    if (show.station && show.station.running) hero.appendChild(el("span", "hqm-dj-pill", live ? "Sur le PC" : "Station PC"));
    card.appendChild(hero);

    if (prep) card.appendChild(renderDjProgress(prep));
    else if (show.prep && show.prep.error && !live) {
      var failed = el("div", "hqm-banner hqm-dj-error");
      failed.appendChild(el("span", "", show.prep.error));
      cardButton(failed, "Réessayer", function () { var again = show.prep.show;
        if (again === "tournament" || again === "tournament_next") return djTournament(again === "tournament_next");
        if (again === "duel") return djDuel();
        return djStart({ show: ["dj", "matinale", "focus", "recap", "premiere"].indexOf(again) >= 0 ? again : "dj" });
      });
      card.appendChild(failed);
    }

    if (!live && !prep) {
      if (show.pending_show) {
        var banner = el("div", "hqm-banner");
        banner.appendChild(el("span", "", show.pending_show === "matinale" ? "Ta matinale est prête." : "Ton récap de la semaine est prêt."));
        cardButton(banner, "Lancer", function () { return djStart({ show: show.pending_show }); }).classList.remove("secondary");
        card.appendChild(banner);
      }
      var launchWrap = el("div", "hqm-dj-launch-wrap");
      var launch = btn("", "hqm-dj-launch", function () {
        launch.disabled = true;
        djStart({ show: "dj" }).catch(function (e) { status(e.message, true); launch.disabled = false; });
      });
      var mic = el("span", "hqm-dj-launch-icon");
      mic.appendChild(svgIcon(ICONS.mic, 26));
      launch.appendChild(mic);
      var words = el("span", "hqm-dj-launch-words");
      words.appendChild(el("strong", "", "Lancer l’émission"));
      words.appendChild(el("span", "", "Musica prend l’antenne"));
      launch.appendChild(words);
      launchWrap.appendChild(launch);
      card.appendChild(launchWrap);
      var tiles = el("div", "hqm-dj-tiles");
      [["matinale", "sun", "Matinale", "Réveil en douceur"], ["focus", "focus", "Bloc focus", "Concentration, peu de mots"],
        ["recap", "replay", "Récap", "Tes chiffres en musique"],
        ["premiere", "star", "En première", show.pending_premiere ? show.pending_premiere + " nouveauté(s) à présenter" : "Les sorties du radar"]]
        .forEach(function (tile) {
          var t = btn("", "hqm-dj-tile" + (tile[0] === "premiere" && show.pending_premiere ? " is-hot" : ""), function () {
            djStart({ show: tile[0] }).catch(function (e) { status(e.message, true); });
          });
          var icon = el("span", "hqm-dj-tile-icon");
          icon.appendChild(svgIcon(ICONS[tile[1]], 20));
          t.appendChild(icon);
          t.appendChild(el("strong", "", tile[2]));
          t.appendChild(el("span", "", tile[3]));
          tiles.appendChild(t);
        });
      card.appendChild(tiles);
    }

    if (live && !prep) {
      var steerBox = el("div", "hqm-dj-steer-box");
      steerBox.appendChild(el("span", "hqm-dj-label", "Oriente l’émission"));
      var chips = el("div", "hqm-dj-steer");
      [["calme", "Plus calme"], ["energie", "Plus d’énergie"], ["change", "Change de vibe"], ["decouverte", "Découvertes"],
        ["nostalgie", "Nostalgie"], ["nouveautes", "Nouveautés"], ["ban", "Pas cet artiste"]].forEach(function (pair) {
        chips.appendChild(btn(pair[1], "hqm-dj-chip", function () {
          djSteer({ preset: pair[0] }).catch(function (e) { status(e.message, true); });
        }));
      });
      steerBox.appendChild(chips);
      var ask = el("form", "hqm-dj-ask");
      var input = document.createElement("input");
      input.type = "text";
      input.maxLength = 300;
      input.placeholder = "Dis-lui quoi passer… « du métal des années 2000 »";
      input.setAttribute("aria-label", "Demande au DJ");
      ask.appendChild(input);
      var send = btn("", "hqm-dj-send");
      send.type = "submit";
      send.setAttribute("aria-label", "Envoyer la demande au DJ");
      send.appendChild(svgIcon(ICONS.next, 18));
      ask.appendChild(send);
      ask.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!input.value.trim()) return;
        djSteer({ text: input.value.trim() }).catch(function (e) { status(e.message, true); });
      });
      steerBox.appendChild(ask);
      card.appendChild(steerBox);
      if (show.segment && show.segment.fallback_reason) {
        card.appendChild(el("p", "hqm-muted hqm-hint", "Segment simplifié : l’IA n’a pas répondu à temps (" +
          show.segment.fallback_reason + "). Le prochain réessaiera."));
      }
      if (show.segment) card.appendChild(djSegmentList(show.segment, "Segment en cours"));
      if (st.picks !== false) card.appendChild(renderDjPicks(show.picks || {}));
      if (show.next) card.appendChild(el("p", "hqm-muted hqm-hint", "Ensuite : " + show.next.title));
      var stopRow = el("div", "hqm-row");
      var skipSeg = cardButton(stopRow, show.next ? "⏭ Segment suivant" : "⏭ Segment suivant (en préparation)", async function () {
        unlockAudio();
        var data = await call("/api/musica/dj/next", "POST", {});
        state.djShow = data;
        if (data.awaiting) introThenGo(data.awaiting, data);
        else if (data.jump === "pending") watchAwaiting();
        status(data.jump === "now" ? "On passe au segment suivant : " + (show.next ? show.next.title : "") :
          data.jump === "pending" ? "Le prochain segment se termine de préparer, j’y passe dès qu’il est prêt." :
            "Impossible de passer au segment suivant pour l’instant.");
        setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 1200);
        paintDjCard();
      });
      skipSeg.classList.add("hqm-dj-skipseg");
      var stop = cardButton(stopRow, "■ Rendre l’antenne", async function () {
        state.djShow = await call("/api/musica/dj/stop", "POST", {});
        status("DJ Musica hors antenne.");
        paintDjCard();
      });
      stop.classList.add("hqm-dj-stop");
      card.appendChild(stopRow);
    }

    var guests = el("div", "hqm-dj-guests");
    guests.appendChild(el("span", "hqm-dj-label", show.guest_request ? "Invitée au prochain segment : " +
      (show.guest_request === "else" ? "Else" : "Transferania") : "Inviter une sœur"));
    [["transferania", "Transferania"], ["else", "Else"]].forEach(function (pair) {
      var g = cardButton(guests, pair[1], async function () {
        state.djShow = await call("/api/musica/dj/guest", "POST", { who: pair[0] });
        status(pair[1] + " passera au prochain segment.");
        paintDjCard();
      });
      g.classList.add("hqm-dj-guest", "is-" + pair[0]);
      if (show.guest_request === pair[0]) g.classList.add("is-on");
    });
    card.appendChild(guests);

    if (!prep) card.appendChild(renderDjDuel(show.duels || {}, live));
    card.appendChild(renderDjArchive());
    if (!prep) card.appendChild(renderMoodDial(show));  // calm to hype, with a time budget
    card.appendChild(renderDjLearned(show.learned || {}));

    var settingsBox = el("details", "hqm-advanced hqm-dj-settings");
    var summary = document.createElement("summary");
    summary.textContent = "Réglages de l’émission";
    settingsBox.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    function save(change) {
      return call("/api/musica/dj/settings", "POST", change).then(function (data) {
        state.djShow = data;
        paintDjCard();
      }).catch(function (e) { status(e.message, true); paintDjCard(); });
    }
    function select(label, key, options) {
      var wrap = el("label", "", label);
      var sel = document.createElement("select");
      options.forEach(function (pair) { sel.appendChild(new Option(pair[1], pair[0])); });
      sel.value = st[key];
      sel.addEventListener("change", function () { var c = {}; c[key] = sel.value; save(c); });
      wrap.appendChild(sel);
      return wrap;
    }
    function check(label, checked, onChange) {
      var wrap = el("label", "hqm-check");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = !!checked;
      box.addEventListener("change", function () { onChange(box.checked); });
      wrap.append(box, " " + label);
      return wrap;
    }
    body.appendChild(select("Bavardage", "chattiness", [["discret", "Discret (intro de segment)"], ["normal", "Normal"], ["bavarde", "Bavarde (entre chaque titre)"]]));
    body.appendChild(select("Invitées spontanées", "guests", [["jamais", "Jamais"], ["rare", "Rarement"], ["souvent", "Souvent"]]));
    body.appendChild(select("Petites blagues", "humor", [["jamais", "Jamais"], ["parfois", "Parfois"], ["souvent", "Souvent"]]));
    body.appendChild(renderDjCharm(show, st, save));
    body.appendChild(select("Musique par défaut", "direction", [["energie", "Plus d’énergie"], ["calme", "Plus calme"], ["decouverte", "Découvertes"], ["nostalgie", "Nostalgie"], ["nouveautes", "Nouveautés"], ["aucune", "Laisse-la choisir"]]));
    body.appendChild(select("Langue à l’antenne", "language", [["auto", "Auto (suit la voix de Musica" + (show.language ? " : " + (show.language === "en" ? "anglais" : "français") : "") + ")"], ["en", "English"], ["fr", "Français"]]));
    body.appendChild(renderDjVoiceBox(show, st, save, select));
    var jingleRow = el("div", "hqm-row");
    jingleRow.appendChild(check("Habillage sonore (jingles + fond sous la voix, créés par le Studio)", st.jingles, function (v) { save({ jingles: v }); }));
    var jingles = show.jingles || {};
    var ready = Object.keys(jingles).filter(function (k) { return jingles[k]; }).length;
    jingleRow.appendChild(el("span", "hqm-muted", ready + "/3 prêts"));
    if (ready < 3) cardButton(jingleRow, "Créer l’habillage", async function () {
      var data = await call("/api/musica/dj/jingles", "POST", {});
      status(data.started ? "Le Studio crée le jingle « " + data.started + " » (un à la fois)." : "Un jingle est déjà en cours de création.");
    });
    body.appendChild(jingleRow);
    body.appendChild(check("Station PC : Musica parle sur les haut-parleurs du PC quand Spotify joue sur ce PC, même Musique fermé",
      st.station, function (v) { save({ station: v }); }));
    body.appendChild(check("En première : les nouveautés du radar ouvrent le segment suivant", st.premiere, function (v) { save({ premiere: v }); }));
    body.appendChild(check("Les paris de Musica : un titre par segment qu’elle défend, gagné si tu l’écoutes jusqu’au bout",
      st.picks !== false, function (v) { save({ picks: v }); }));
    body.appendChild(check("Anecdotes vérifiées : Musica cherche sur le web un fait vrai sur les titres dont elle parle (40 recherches par jour au plus)",
      st.facts !== false, function (v) { save({ facts: v }); }));
    var morning = st.morning || {};
    var mRow = el("div", "hqm-row hqm-dj-schedule");
    mRow.appendChild(check("Matinale à", morning.enabled, function (v) { save({ morning: { enabled: v } }); }));
    var mTime = document.createElement("input");
    mTime.type = "time";
    mTime.value = morning.time || "07:30";
    mTime.setAttribute("aria-label", "Heure de la matinale");
    mTime.addEventListener("change", function () { save({ morning: { time: mTime.value } }); });
    mRow.appendChild(mTime);
    ["L", "M", "M", "J", "V", "S", "D"].forEach(function (letter, day) {
      var on = (morning.days || []).indexOf(day) >= 0;
      var b = btn(letter, "hqm-day" + (on ? " is-on" : ""), function () {
        var days = (morning.days || []).slice();
        if (on) days = days.filter(function (d) { return d !== day; }); else days.push(day);
        save({ morning: { days: days } });
      });
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.setAttribute("aria-label", WEEKDAYS_LONG[day]);
      mRow.appendChild(b);
    });
    body.appendChild(mRow);
    var recap = st.recap || {};
    var rRow = el("div", "hqm-row hqm-dj-schedule");
    rRow.appendChild(check("Récap du dimanche à", recap.enabled, function (v) { save({ recap: { enabled: v } }); }));
    var rTime = document.createElement("input");
    rTime.type = "time";
    rTime.value = recap.time || "18:00";
    rTime.setAttribute("aria-label", "Heure du récap");
    rTime.addEventListener("change", function () { save({ recap: { time: rTime.value } }); });
    rRow.appendChild(rTime);
    body.appendChild(rRow);
    body.appendChild(el("p", "hqm-muted hqm-hint",
      "Matinale et récap : avec la station PC, l’émission démarre sur le PC ; sinon tu reçois une notification (si activée dans HQ) et un bouton « Lancer » ici."));
    var accompany = el("div", "hqm-dj-accompany");
    accompany.appendChild(el("strong", "", "Hors émission"));
    renderDjSettings(accompany);
    body.appendChild(accompany);
    settingsBox.appendChild(body);
    card.appendChild(settingsBox);
    return card;
  }

  function renderDjVoiceBox(show, st, save, select) {
    var box = el("div", "hqm-dj-voice");
    box.appendChild(el("strong", "", "Voix de Musica"));
    box.appendChild(select("Moteur", "voice_engine", [["auto", "Auto (Chatterbox quand il est prêt)"], ["chatterbox", "Chatterbox (expressive)"], ["phonon", "Phonon (rapide)"]]));
    var expr = el("label", "", "Expressivité (Chatterbox)");
    var exprSel = document.createElement("select");
    [["0.8", "Sobre"], ["1", "Normale"], ["1.2", "Vive"], ["1.4", "Très vive"]].forEach(function (pair) {
      exprSel.appendChild(new Option(pair[1], pair[0]));
    });
    var level = Number(st.expressiveness || 1.4);
    exprSel.value = String([0.8, 1, 1.2, 1.4].reduce(function (best, v) { return Math.abs(v - level) < Math.abs(best - level) ? v : best; }, 1.2));
    exprSel.addEventListener("change", function () { save({ expressiveness: Number(exprSel.value) }); });
    expr.appendChild(exprSel);
    box.appendChild(expr);
    var cb = (show.voice && show.voice.chatterbox) || {};
    var line = !cb.installed ? "Chatterbox n’est pas installé." :
      cb.ready ? "Chatterbox prêt" + (cb.device ? " sur " + (cb.device === "cuda" ? "la carte graphique" : cb.device) : "") +
        (cb.vram_mb ? " · " + cb.vram_mb + " Mo de VRAM" : "") + (cb.reference ? " · voix clonée prête" : " · voix à cloner") :
        cb.daemon ? "Chatterbox charge son modèle…" + (cb.error ? " (" + cb.error + ")" : "") : "Chatterbox est arrêté (il démarre tout seul au besoin).";
    box.appendChild(el("p", "hqm-muted hqm-hint", line + (show.language === "fr" ? " Chatterbox ne parle qu’anglais." : "")));
    var row = el("div", "hqm-row");
    var results = el("div", "hqm-dj-compare");
    cardButton(row, "Comparer les voix", async function () {
      unlockAudio();
      results.replaceChildren(el("p", "hqm-muted", "Musica enregistre la même réplique avec les deux voix…"));
      var data = await call("/api/musica/dj/voice-compare", "POST", { mood: "hype" });
      results.replaceChildren(el("p", "hqm-muted hqm-hint", "« " + data.text + " »"));
      [["phonon", "A · Phonon"], ["chatterbox", "B · Chatterbox"]].forEach(function (pair) {
        var name = data[pair[0]];
        var item = el("div", "hqm-row");
        item.appendChild(el("span", "hqm-dj-compare-label", pair[1]));
        if (name) {
          cardButton(item, "▶ Écouter", function () { return playDrops([name], "", false); });
          cardButton(item, "Garder cette voix", function () { return save({ voice_engine: pair[0] }); });
        } else {
          item.appendChild(el("span", "hqm-muted", "indisponible"));
        }
        results.appendChild(item);
      });
      if (data.note) results.appendChild(el("p", "hqm-muted hqm-hint", data.note));
    });
    if (cb.installed) cardButton(row, "Recloner sa voix", async function () {
      var data = await call("/api/musica/dj/voice-reference", "POST", {});
      state.djShow = data;
      status(data.ok ? "Voix de référence enregistrée depuis sa voix Phonon." : (data.error || "Échec du clonage."), !data.ok);
      paintDjCard();
    });
    box.append(row, results);
    box.appendChild(renderVoiceWorker());
    return box;
  }

  /* Voix sur un autre PC: the Chatterbox GPU work goes to a paired laptop (hq_voice_worker.py), with this PC as fallback. */
  function renderVoiceWorker() {
    var box = el("div", "hqm-voice-worker");
    box.appendChild(el("strong", "", "Voix sur un autre PC"));
    var body = el("div", "hqm-voice-worker-body");
    box.appendChild(body);
    function paint(w) {
      body.replaceChildren();
      if (!w) { body.appendChild(el("p", "hqm-muted hqm-loading", "Chargement…")); return; }
      function act(path, payload, done) {
        call("/api/musica/dj/voice-worker/" + path, "POST", payload || {}).then(function (d) {
          if (path === "code") { if (done) done(d); return; }  // the code stays on screen: no repaint
          state.voiceWorker = d;
          paint(d);
        }).catch(function (e) { status(e.message, true); });
      }
      if (!w.paired) {
        body.appendChild(el("p", "hqm-muted", "Aucun PC associé. Un portable avec une carte NVIDIA peut générer sa voix pour libérer le GPU de ce PC ; en cas de panne, ce PC reprend."));
        var out = el("div", "hqm-voice-worker-code");
        body.appendChild(btn("Créer un code d’association", "hqm-btn secondary", function () {
          act("code", {}, function (d) {
            out.replaceChildren(el("code", "", d.code), el("p", "hqm-muted hqm-hint", "Valable 10 minutes, à usage unique. Sur l’autre PC : py -3 hq_voice_worker.py pair --hq <adresse HQ> --name \"Portable\""));
          });
        }));
        body.appendChild(out);
        return;
      }
      var line = el("p", "", (w.name || "PC") + " · " + (w.online ? "en ligne" : "hors ligne") + (w.gpu ? " · " + w.gpu : "") + (w.vram_mb ? " (" + Math.round(w.vram_mb / 1024) + " Go)" : "") +
        (w.online && w.ready === false ? " · modèle en chargement" : ""));
      body.appendChild(line);
      var facts = [];
      if (w.done) facts.push(w.done + " phrase" + (w.done > 1 ? "s" : "") + " générée" + (w.done > 1 ? "s" : "") + (w.last_ms ? ", dernière en " + (w.last_ms / 1000).toFixed(1) + " s" : ""));
      if (w.breaker_open) facts.push("en pause un instant après des échecs : ce PC reprend la main");
      if (w.last_error) facts.push("dernier incident : " + w.last_error);
      if (facts.length) body.appendChild(el("p", "hqm-muted hqm-hint", facts.join(" · ")));
      var use = el("label", "hqm-station-moments");
      var box2 = document.createElement("input");
      box2.type = "checkbox";
      box2.checked = w.enabled !== false;
      box2.addEventListener("change", function () { act("enable", { enabled: box2.checked }); });
      use.appendChild(box2);
      use.appendChild(document.createTextNode(" Utiliser ce PC pour la voix quand il est en ligne"));
      body.appendChild(use);
      body.appendChild(btn("Retirer cet appareil", "hqm-btn secondary", function () {
        if (window.confirm("Retirer cet appareil ? Il faudra un nouveau code pour le réassocier.")) act("remove");
      }));
    }
    paint(state.voiceWorker || null);
    // This box is rebuilt with the DJ card at every poll: read the status at most every 15 s, not at every repaint.
    if (!state.voiceWorker || Date.now() - (state.voiceWorkerAt || 0) > 15000) {
      state.voiceWorkerAt = Date.now();
      call("/api/musica/dj/voice-worker").then(function (d) { state.voiceWorker = d; paint(d); }).catch(function () {
        if (!state.voiceWorker) body.replaceChildren(el("p", "hqm-muted", "État indisponible pour le moment."));
      });
    }
    return box;
  }

  /* « Charme »: how flirty she is on air. Séduisante needs HQ's adult mode (checked by the server too). */
  function renderDjCharm(show, st, save) {
    var charm = show.charm || {};
    var wrap = el("label", "hqm-dj-charm", "Charme");
    var sel = document.createElement("select");
    [["complice", "Complice (chaleureuse, taquine)"], ["charmeuse", "Charmeuse (flirt élégant)"],
      ["seduisante", "Séduisante (sensuelle, mode adulte)"]].forEach(function (pair) {
      var option = new Option(pair[1], pair[0]);
      if (pair[0] === "seduisante" && !charm.adult && st.charm !== "seduisante") option.disabled = true;
      sel.appendChild(option);
    });
    sel.value = st.charm || "complice";
    sel.addEventListener("change", function () { save({ charm: sel.value }); });
    wrap.appendChild(sel);
    if (st.charm === "seduisante" && charm.level !== "seduisante") {
      wrap.appendChild(el("span", "hqm-muted hqm-hint", "Mode adulte désactivé : elle reste Charmeuse pour l’instant."));
    } else if (!charm.adult) {
      wrap.appendChild(el("span", "hqm-muted hqm-hint", "Séduisante s’active avec le mode adulte de HQ."));
    }
    return wrap;
  }

  async function djDuel() {
    unlockAudio();
    state.prepDisplay = 2;
    var data = await call("/api/musica/dj/duel", "POST", { device_id: state.preferredDeviceId || undefined });
    state.djShow = data;
    paintDjCard();
    watchPrep();
    return data;
  }

  async function djVote(choice) {
    var data = await call("/api/musica/dj/duel/vote", "POST", { choice: choice });
    state.djShow = data;
    var res = data.result || {};
    var vote = data.duels && data.duels.current && data.duels.current.vote;
    if (res.winner && vote) {
      var nameOf = function (r) { return r.name + ((r.artists || []).length ? " — " + r.artists[0] : ""); };
      var sideA = vote === "a" ? res.winner : res.loser;
      var sideB = vote === "a" ? res.loser : res.winner;
      ensureTourn().reveal = { id: data.duels.current.id, blind: !!res.blind, upset: !!res.upset, a: nameOf(sideA), b: nameOf(sideB),
        aImage: sideA.image || null, bImage: sideB.image || null, winner: vote,
        daily: !!(data.duels.current && data.duels.current.daily) };
    }
    if (res.final) { loadHall().then(paintDjCard); watchCameo(); }
    if (res.winner) announce((res.blind ? "Révélation : " : "") + "tu as choisi " + res.winner.name + ((res.winner.artists || [])[0] ? " de " + res.winner.artists[0] : "") +
      ", contre " + res.loser.name + (res.upset ? ". Surprise : un outsider l’emporte." : "."));
    paintDjCard();
    blindMasking();
    refreshQueueCard();  // the blind-match mask lifts with the verdict
    musicaReact("listen-off");
    musicaReact(res.final ? "final" : res.upset ? "jump" : res.foreseen ? "nod" : "shrug");
    if (res.final && res.final.prediction) {
      setTimeout(function () { musicaReact(res.final.prediction.same ? "spin" : "droop"); }, 3000);  // her secret pick: pleased or pouting
    }
    if (data.text) {
      musicaSay(data.text);
      state.djLast = { text: data.text, at: Date.now() };
      paintDjLine();
      // The verdict is already on screen; her written reaction streams in, and only that one is spoken.
      if (data.reaction && data.reaction.pending) streamReaction(data.reaction.id, data.text);
      else speakMusica(data.text).catch(function () {});
    }
    return data;
  }

  function streamQuizReaction(data) {
    var tries = 0;
    function done(text) {
      if (text && text !== data.line && ensureQuiz().result === data) {
        data.line = text;
        musicaSay(text, true);
        render();
      }
      if (state.musicaSpeaks) speakMusica(text || data.line).catch(function () {});
    }
    (function poll() {
      tries += 1;
      call("/api/music/quiz/reaction/" + encodeURIComponent(data.reaction.id), "GET").then(function (r) {
        if (r && r.pending && tries < 20) setTimeout(poll, 700);
        else done(r && r.text);
      }).catch(function () { if (tries < 3) setTimeout(poll, 900); else done(""); });
    })();
  }

  function streamReaction(id, fallback) {
    var tries = 0;
    function done(text) {
      if (text && text !== (state.djLast && state.djLast.text)) {
        musicaSay(text);
        state.djLast = { text: text, at: Date.now() };
        paintDjLine();
      }
      speakMusica(text || fallback).catch(function () {});
    }
    (function poll() {
      tries += 1;
      call("/api/musica/dj/duel/reaction/" + encodeURIComponent(id), "GET").then(function (r) {
        if (r && r.pending && tries < 20) setTimeout(poll, 700);
        else done(r && r.text);
      }).catch(function () { if (tries < 3) setTimeout(poll, 900); else done(""); });
    })();
  }

  /* Le Duel: two tracks, one vote, the winner holds the title. */
  function renderDjDuel(duels, live) {
    var box = el("div", "hqm-dj-duel");
    var head = el("div", "hqm-dj-picks-head");
    head.appendChild(el("span", "hqm-dj-label", "Le Duel"));
    if (duels.played) head.appendChild(el("strong", "hqm-dj-picks-score", "Ses pronostics : " + (duels.right || 0) + " ✓ · " + (duels.wrong || 0) + " ✗"));
    box.appendChild(head);
    var cur = duels.current;
    if (cur) {
      var versus = el("div", "hqm-dj-duel-sides");
      [["a", cur.a], ["b", cur.b]].forEach(function (pair) {
        var side = el("div", "hqm-dj-duel-side" + (cur.vote === pair[0] ? " is-winner" : cur.vote ? " is-loser" : ""));
        side.appendChild(el("strong", "", pair[1].name));
        side.appendChild(el("span", "hqm-muted", (pair[1].artists || []).join(", ")));
        if (cur.champion === pair[0] && !cur.vote) side.appendChild(el("span", "hqm-chip is-static", "Tenant du titre"));
        if (cur.vote) {
          if (cur.prediction === pair[0]) side.appendChild(el("span", "hqm-chip is-static", "Son pronostic"));
        } else {
          side.appendChild(btn("Je choisis celui-ci", "hqm-btn", function () {
            djVote(pair[0]).catch(function (e) { status(e.message, true); });
          }));
        }
        versus.appendChild(side);
      });
      box.appendChild(versus);
      if (!cur.vote) box.appendChild(el("p", "hqm-muted hqm-hint", "Écoute les deux titres, puis tranche (ou dis « DJ, le premier / le deuxième »)."));
    }
    if (duels.champion) {
      box.appendChild(el("p", "hqm-dj-duel-champion", "🏆 Tenant du titre : " + duels.champion.name +
        ((duels.champion.artists || []).length ? " — " + duels.champion.artists[0] : "") +
        " (" + (duels.champion.defenses || 0) + "/" + (duels.reign || 3) + " défenses)"));
    }
    if (!state.djShow || !(state.djShow.prep && state.djShow.prep.running)) {
      var go = btn(cur && !cur.vote ? "Nouveau duel" : "⚔ Lancer un duel", "hqm-btn secondary", function () {
        go.disabled = true;
        djDuel().catch(function (e) { status(e.message, true); go.disabled = false; });
      });
      box.appendChild(go);
    }
    if ((duels.hall || []).length) {
      var hall = el("div", "hqm-preset-row");
      hall.appendChild(el("span", "hqm-muted", "Panthéon :"));
      duels.hall.forEach(function (r) { hall.appendChild(el("span", "hqm-chip is-static", r.name)); });
      box.appendChild(hall);
    }
    return box;
  }

  /* ---- Journal: Wrapped (week / month / year), « Ce jour-là » and the taste map ---------------------------------------- */

  function ensureRecap() {
    if (!state.recap) state.recap = { period: "month", wrapped: null, today: null, map: null, loading: {} };
    return state.recap;
  }

  async function loadWrapped(period) {
    var rc = ensureRecap();
    rc.period = period || rc.period;
    rc.loading.wrapped = true;
    try { rc.wrapped = await call("/api/music/wrapped/" + rc.period); }
    catch (err) { rc.wrapped = { ok: false, error: err.message }; }
    finally { rc.loading.wrapped = false; }
    if (state.tab === "journal") render();
  }

  async function loadOnThisDay() {
    var rc = ensureRecap();
    try { rc.today = await call("/api/music/on-this-day"); } catch (_e) { rc.today = { years: [], empty: true }; }
    if (state.tab === "journal") render();
  }

  async function loadTasteMap() {
    var rc = ensureRecap();
    rc.loading.map = true;
    try { rc.map = await call("/api/music/taste-map"); } catch (err) { rc.map = { ok: false, error: err.message, nodes: [] }; }
    finally { rc.loading.map = false; }
    if (state.tab === "journal") render();
  }

  function renderWrapped(host) {
    var rc = ensureRecap();
    var card = el("section", "hqm-card hqm-wrapped");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Ton récap"));
    copy.appendChild(el("p", "hqm-muted", "Ce que tu as vraiment écouté, quand tu veux. Une carte à garder ou à partager."));
    head.appendChild(copy);
    var tabs = el("div", "hqm-seg");
    tabs.setAttribute("role", "group");
    tabs.setAttribute("aria-label", "Période du récap");
    [["week", "Semaine"], ["month", "Mois"], ["year", "Année"]].forEach(function (pair) {
      var b = btn(pair[1], "hqm-seg-btn" + (rc.period === pair[0] ? " is-on" : ""), function () { loadWrapped(pair[0]); });
      b.setAttribute("aria-pressed", rc.period === pair[0] ? "true" : "false");
      tabs.appendChild(b);
    });
    head.appendChild(tabs);
    card.appendChild(head);
    var w = rc.wrapped;
    if (!w || rc.loading.wrapped) {
      card.appendChild(el("p", "hqm-muted hqm-loading", "Chargement…"));
    } else if (w.ok === false) {
      card.appendChild(el("p", "hqm-muted", w.error || "Récap indisponible."));
    } else if (w.empty) {
      card.appendChild(el("p", "hqm-muted", "Pas encore d’écoute enregistrée sur cette période (« " + w.label + " »)."));
    } else {
      var live = el("div", "hqm-wrapped-body");
      live.setAttribute("aria-live", "polite");
      live.appendChild(el("h4", "hqm-wrapped-label", w.label));
      var tiles = el("div", "hqm-stat-grid");
      tiles.appendChild(statTile(w.plays, "écoutes"));
      tiles.appendChild(statTile(w.hours + " h", "de musique"));
      tiles.appendChild(statTile(w.active_days, "jours actifs"));
      tiles.appendChild(statTile(w.longest_streak, "jours d’affilée"));
      live.appendChild(tiles);
      var delta = w.previous && w.previous.delta;
      if (w.previous && (w.previous.plays || delta)) {
        live.appendChild(el("p", "hqm-muted", (delta >= 0 ? "▲ " : "▼ ") + Math.abs(delta) + " écoutes par rapport à la période précédente (" + w.previous.plays + ")."));
      }
      var cols = el("div", "hqm-wrapped-cols");
      var tops = el("div", "");
      tops.appendChild(el("strong", "hqm-dj-label", "Artistes les plus écoutés"));
      var ol = el("ol", "hqm-dj-tracks");
      (w.top_artists || []).forEach(function (a) { ol.appendChild(el("li", "", a.name + " · " + a.plays)); });
      tops.appendChild(ol);
      cols.appendChild(tops);
      var tracks = el("div", "");
      tracks.appendChild(el("strong", "hqm-dj-label", "Titres en boucle"));
      var ol2 = el("ol", "hqm-dj-tracks");
      (w.top_tracks || []).forEach(function (t) { ol2.appendChild(el("li", "", t.name + " — " + (t.artists || [])[0] + " · " + t.plays)); });
      tracks.appendChild(ol2);
      cols.appendChild(tracks);
      live.appendChild(cols);
      if ((w.new_artists || []).length) {
        var fresh = el("p", "", "🌱 Découvertes : " + w.new_artists.map(function (a) { return a.name; }).join(", ") +
          (w.new_artist_count > w.new_artists.length ? " et " + (w.new_artist_count - w.new_artists.length) + " autre(s)" : "") + ".");
        live.appendChild(fresh);
      }
      var rhythm = [];
      if (w.busiest_weekday) rhythm.push("jour préféré : " + w.busiest_weekday);
      if (w.busiest_hour != null) rhythm.push("heure d’écoute : " + w.busiest_hour + " h");
      if (rhythm.length) live.appendChild(el("p", "hqm-muted", rhythm.join(" · ")));
      var row = el("div", "hqm-row");
      cardButton(row, "🖼 Carte de partage", function () { return wrappedCard(w); });
      live.appendChild(row);
      card.appendChild(live);
    }
    host.appendChild(card);
  }

  function renderOnThisDay(host) {
    var rc = ensureRecap();
    var card = el("section", "hqm-card hqm-today");
    var head = el("div", "hqm-card-head");
    head.appendChild(el("h3", "", "Ce jour-là"));
    card.appendChild(head);
    var data = rc.today;
    if (!data) { card.appendChild(el("p", "hqm-muted hqm-loading", "Chargement…")); host.appendChild(card); return; }
    if (data.empty || !(data.years || []).length) {
      card.appendChild(el("p", "hqm-muted", "Rien d’enregistré à cette date les années passées. Le journal se remplit chaque jour."));
    }
    (data.years || []).forEach(function (y) {
      var block = el("div", "hqm-today-year");
      block.appendChild(el("strong", "", "Il y a " + y.years_ago + " an" + (y.years_ago > 1 ? "s" : "") + " · " + dayLabel(y.date)));
      block.appendChild(el("span", "hqm-muted", y.plays + " écoute" + (y.plays > 1 ? "s" : "")));
      var ol = el("ol", "hqm-dj-tracks");
      (y.tracks || []).forEach(function (t) {
        var li = el("li", "");
        li.appendChild(document.createTextNode(t.name + " — " + (t.artists || []).join(", ") + (t.plays > 1 ? " ×" + t.plays : "")));
        if (t.uri) {
          var play = btn("▶", "hqm-today-play", function () {
            playerAction("play", { uris: [t.uri] }).catch(function (e) { status(friendlyPlayerError(e), true); });
          });
          play.setAttribute("aria-label", "Écouter " + t.name);
          li.appendChild(play);
        }
        ol.appendChild(li);
      });
      block.appendChild(ol);
      card.appendChild(block);
    });
    host.appendChild(card);
  }

  /* The taste map: artists you play, linked when played back to back, coloured by cluster. */
  function renderTasteMap(host) {
    var rc = ensureRecap();
    var box = el("details", "hqm-advanced hqm-map-box");
    var summary = document.createElement("summary");
    summary.textContent = "Carte de tes goûts";
    box.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    box.appendChild(body);
    box.open = !!rc.mapOpen;
    box.addEventListener("toggle", function () {
      rc.mapOpen = box.open;
      if (box.open && !rc.map && !rc.loading.map) loadTasteMap();
    });
    var map = rc.map;
    if (!map) {
      body.appendChild(el("p", "hqm-muted" + (rc.loading.map ? " hqm-loading" : ""), rc.loading.map ? "Je trace la carte…" : "Ouvre pour tracer la carte de tes 90 derniers jours."));
    } else if (map.ok === false || map.empty || !(map.nodes || []).length) {
      body.appendChild(el("p", "hqm-muted", map.error || "Pas assez d’écoutes récentes pour dessiner une carte."));
    } else {
      body.appendChild(tasteMapSvg(map));
      body.appendChild(el("p", "hqm-muted hqm-hint", "Touche un point pour ouvrir l’artiste ; zoome avec + / − ou la molette, glisse pour te déplacer. Chaque point est un artiste (plus gros = plus écouté) ; un trait relie deux artistes écoutés l’un après l’autre ; une couleur = un groupe d’écoute."));
      var list = el("ul", "hqm-map-clusters");
      (map.clusters || []).forEach(function (c, i) {
        var li = el("li", "");
        var dot = el("span", "hqm-map-dot");
        dot.style.background = "hsl(" + ((c.id * 67) % 360) + ",70%,60%)";
        li.appendChild(dot);
        li.appendChild(document.createTextNode(" Groupe " + (i + 1) + " : " + c.members.join(", ") + (c.size > c.members.length ? "…" : "")));
        list.appendChild(li);
      });
      body.appendChild(list);
      if ((map.quiet || []).length) {
        var quiet = el("p", "", "😴 En sommeil : " + map.quiet.map(function (q) { return q.name; }).join(", ") + " — beaucoup écoutés avant, plus rien ce dernier mois.");
        body.appendChild(quiet);
      }
      if ((map.loners || []).length) body.appendChild(el("p", "hqm-muted", "Électrons libres (aucun lien fort) : " + map.loners.join(", ") + "."));
    }
    host.appendChild(box);
  }

  function tasteMapSvg(map) {
    var ns = "http://www.w3.org/2000/svg";
    var W = 640, H = 420;
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("class", "hqm-map");
    svg.setAttribute("role", "img");
    svg.setAttribute("aria-label", "Carte des goûts : " + map.nodes.length + " artistes en " + map.clusters.length + " groupes");
    var ids = map.clusters.map(function (c) { return c.id; });
    var spread = ids.length > 1 ? Math.min(W, H) * 0.3 : 0;
    var centers = {};
    ids.forEach(function (id, i) {
      var angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
      centers[id] = { x: W / 2 + Math.cos(angle) * spread * 1.35, y: H / 2 + Math.sin(angle) * spread };
    });
    var members = {};
    map.nodes.forEach(function (n) { (members[n.cluster] = members[n.cluster] || []).push(n); });
    var pos = {};
    Object.keys(members).forEach(function (id) {
      var list = members[id];
      var center = centers[Number(id)];
      var ring = list.length === 1 ? 0 : 24 + list.length * 7;
      list.forEach(function (n, i) {
        var a = (i / list.length) * Math.PI * 2;
        pos[n.id] = { x: center.x + Math.cos(a) * ring, y: center.y + Math.sin(a) * ring };
      });
    });
    function add(tag, attrs, text) {
      var node = document.createElementNS(ns, tag);
      Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
      if (text != null) node.textContent = text;
      svg.appendChild(node);
      return node;
    }
    (map.edges || []).forEach(function (e) {
      if (!pos[e.a] || !pos[e.b]) return;
      add("line", { x1: pos[e.a].x, y1: pos[e.a].y, x2: pos[e.b].x, y2: pos[e.b].y, stroke: "currentColor",
        "stroke-opacity": String(Math.min(0.55, 0.12 + e.weight * 0.07)), "stroke-width": String(1 + Math.min(4, e.weight * 0.3)) });
    });
    var maxPlays = Math.max.apply(null, map.nodes.map(function (n) { return n.plays; }));
    map.nodes.forEach(function (n, i) {
      var p = pos[n.id];
      var r = 5 + Math.sqrt(n.plays) * 2.4;
      var circle = add("circle", { cx: p.x, cy: p.y, r: r, fill: "hsl(" + ((n.cluster * 67) % 360) + ",70%,60%)", "fill-opacity": n.linked ? "0.95" : "0.55",
        "class": "hqm-map-node", tabindex: "0", role: "button", "aria-label": n.name + ", " + n.plays + " écoutes : ouvrir la page de l’artiste" });
      var title = document.createElementNS(ns, "title");
      title.textContent = n.name + " · " + n.plays + " écoutes";
      circle.appendChild(title);
      var open = function () { openArtist({ name: n.name }); };
      circle.addEventListener("click", function () { if (!svg.__dragged) open(); });
      circle.addEventListener("keydown", function (ev) { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); open(); } });
      if (i < 12 || n.plays >= maxPlays * 0.4) add("text", { x: p.x, y: p.y - r - 4, "text-anchor": "middle", "font-size": "11", fill: "currentColor", "pointer-events": "none" }, n.name);
    });
    return mapZoom(svg, W, H);
  }

  /* Zoom and pan for the taste map: buttons, wheel and drag all just move the SVG viewBox. */
  function mapZoom(svg, W, H) {
    var wrap = el("div", "hqm-map-wrap");
    var view = { x: 0, y: 0, w: W, h: H };
    function apply() {
      view.w = Math.max(W / 6, Math.min(W, view.w)); view.h = view.w * H / W;
      view.x = Math.max(0, Math.min(W - view.w, view.x)); view.y = Math.max(0, Math.min(H - view.h, view.y));
      svg.setAttribute("viewBox", view.x + " " + view.y + " " + view.w + " " + view.h);
    }
    function zoom(factor, cx, cy) {
      cx = cx == null ? view.x + view.w / 2 : cx; cy = cy == null ? view.y + view.h / 2 : cy;
      var w = Math.max(W / 6, Math.min(W, view.w * factor)), k = w / view.w;
      view.x = cx - (cx - view.x) * k; view.y = cy - (cy - view.y) * k; view.w = w;
      apply();
    }
    var tools = el("div", "hqm-map-tools");
    tools.appendChild(btn("+", "hqm-btn hqm-map-zoom", function () { zoom(0.7); }));
    tools.appendChild(btn("−", "hqm-btn hqm-map-zoom", function () { zoom(1 / 0.7); }));
    tools.appendChild(btn("Recentrer", "hqm-btn hqm-map-zoom", function () { view = { x: 0, y: 0, w: W, h: H }; apply(); }));
    tools.lastChild.setAttribute("aria-label", "Recentrer la carte");
    tools.firstChild.setAttribute("aria-label", "Zoom avant");
    tools.children[1].setAttribute("aria-label", "Zoom arrière");
    function at(ev) {
      var r = svg.getBoundingClientRect();
      return { x: view.x + (ev.clientX - r.left) / r.width * view.w, y: view.y + (ev.clientY - r.top) / r.height * view.h, k: view.w / r.width };
    }
    svg.addEventListener("wheel", function (ev) { ev.preventDefault(); var p = at(ev); zoom(ev.deltaY < 0 ? 0.85 : 1 / 0.85, p.x, p.y); }, { passive: false });
    var drag = null;
    svg.addEventListener("pointerdown", function (ev) { var p = at(ev); drag = { sx: ev.clientX, sy: ev.clientY, x: view.x, y: view.y, k: p.k, moved: false }; svg.__dragged = false; });
    svg.addEventListener("pointermove", function (ev) {
      if (!drag) return;
      var dx = ev.clientX - drag.sx, dy = ev.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 6) return;
      drag.moved = true; svg.__dragged = true;
      view.x = drag.x - dx * drag.k; view.y = drag.y - dy * drag.k; apply();
    });
    function end() { drag = null; setTimeout(function () { svg.__dragged = false; }, 0); }
    svg.addEventListener("pointerup", end); svg.addEventListener("pointercancel", end); svg.addEventListener("pointerleave", end);
    wrap.appendChild(tools);
    wrap.appendChild(svg);
    return wrap;
  }

  /* Wrapped share card: drawn on a canvas, saved or shared as a PNG (same approach as the tournament card). */
  async function wrappedCard(w) {
    var W = 1080, H = 1350;
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    var grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#14213d"); grad.addColorStop(1, "#6b21a8");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fbbf24"; ctx.font = "700 34px system-ui, sans-serif";
    ctx.fillText("MON RÉCAP MUSICA", 60, 90);
    ctx.fillStyle = "#ffffff"; ctx.font = "700 64px system-ui, sans-serif";
    ctx.fillText(w.label, 60, 180);
    ctx.font = "600 44px system-ui, sans-serif"; ctx.fillStyle = "#e9d5ff";
    ctx.fillText(w.plays + " écoutes · " + w.hours + " h", 60, 260);
    ctx.font = "400 34px system-ui, sans-serif";
    ctx.fillText(w.active_days + " jours actifs · " + w.longest_streak + " d’affilée", 60, 320);
    ctx.fillStyle = "#fbbf24"; ctx.font = "700 36px system-ui, sans-serif";
    ctx.fillText("Artistes", 60, 440);
    ctx.fillStyle = "#ffffff"; ctx.font = "600 42px system-ui, sans-serif";
    (w.top_artists || []).forEach(function (a, i) { ctx.fillText((i + 1) + ". " + a.name, 60, 510 + i * 68); });
    ctx.fillStyle = "#fbbf24"; ctx.font = "700 36px system-ui, sans-serif";
    ctx.fillText("Titre en boucle", 60, 900);
    ctx.fillStyle = "#ffffff"; ctx.font = "600 40px system-ui, sans-serif";
    var top = (w.top_tracks || [])[0];
    if (top) wrapText(ctx, top.name + " — " + ((top.artists || [])[0] || "") + " (" + top.plays + "×)", 60, 965, 960, 52);
    if ((w.new_artists || []).length) {
      ctx.fillStyle = "#a7f3d0"; ctx.font = "500 34px system-ui, sans-serif";
      wrapText(ctx, "🌱 Découvertes : " + w.new_artists.map(function (a) { return a.name; }).join(", "), 60, 1140, 960, 46);
    }
    ctx.fillStyle = "#e9d5ff"; ctx.font = "400 28px system-ui, sans-serif";
    ctx.fillText("Transfert HQ · Musique", 60, 1300);
    await saveCanvas(canvas, "recap-musica.png", "Mon récap Musica");
  }

  async function saveCanvas(canvas, filename, title) {
    var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/png"); });
    if (!blob) throw new Error("Image indisponible");
    var file = new File([blob], filename, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: title }); return; } catch (_e) { /* cancelled: download instead */ }
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    status("Carte enregistrée.");
  }

  /* ---- Défi du jour: one express blind duel a day, with a streak ------------------------------------------------- */

  async function djDaily() {
    unlockAudio();
    state.prepDisplay = 2;
    ensureTourn().reveal = null;
    var data = await call("/api/musica/dj/daily", "POST", { device_id: state.preferredDeviceId || undefined });
    state.djShow = data;
    paintDjCard();
    watchPrep();
    watchHeard();
    return data;
  }

  function renderDailyCard(host) {
    var tn = ensureTourn();
    var show = state.djShow || {};
    var daily = show.daily || {};
    var cur = show.duels && show.duels.current;
    var open = !!(cur && cur.daily && !cur.vote);
    var busy = show.prep && show.prep.running;
    var card = el("section", "hqm-card hqm-daily");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Défi du jour"));
    copy.appendChild(el("p", "hqm-muted", "Un duel express à l’aveugle, une minute, une fois par jour. Ta série compte les jours d’affilée."));
    head.appendChild(copy);
    var streak = el("div", "hqm-daily-streak");
    streak.setAttribute("aria-label", "Série : " + (daily.streak || 0) + " jours, record " + (daily.best || 0));
    streak.appendChild(el("strong", "", "🔥 " + (daily.streak || 0)));
    streak.appendChild(el("span", "hqm-muted", "record " + (daily.best || 0)));
    head.appendChild(streak);
    card.appendChild(head);
    if (busy) card.appendChild(renderDjProgress(show.prep));
    if (open) card.appendChild(renderTournamentVote(cur));
    else if (tn.reveal && tn.reveal.daily) card.appendChild(renderTournamentResult(tn.reveal));
    if (!open && !busy) {
      var go = btn(daily.done_today ? "✓ Fait aujourd’hui — à demain" : "⚡ Lancer le défi du jour", "hqm-btn hqm-tn-next", function () {
        go.disabled = true;
        djDaily().catch(function (e) { status(e.message, true); go.disabled = false; });
      });
      go.disabled = !!daily.done_today;
      card.appendChild(go);
    }
    host.appendChild(card);
  }

  function ensureTourn() {
    if (!state.tourn) state.tourn = { opts: { blind: true, window: true, wildcard: true, angle: "", theme: "" }, hall: null, reveal: null, skipped: {},
      entered: {}, windowStart: {}, seenWin: {}, kind: "games" };
    return state.tourn;
  }

  var KIND_LABELS = { games: "musiques de jeux vidéo", decade: "tubes d’une décennie", artists: "artistes légendaires",
    albums: "albums cultes", library: "tes favoris récents" };

  async function loadHall(kind) {
    var tn = ensureTourn();
    var wanted = kind || tn.kind || "games";
    try { tn.hall = await call("/api/musica/dj/hall" + (wanted === "games" ? "" : "/" + wanted)); tn.hallError = false; } catch (_e) { tn.hallError = true; }
  }

  async function djTournament(next) {
    unlockAudio();
    state.prepDisplay = 2;
    var tn = ensureTourn();
    var body = { device_id: state.preferredDeviceId || undefined };
    if (!next) {
      var o = tn.opts;
      body.kind = tn.kind;
      body.blind = o.blind;
      body.window = o.window;
      body.wildcard = o.wildcard;
      if (o.theme.trim()) body.theme = o.theme.trim();
      else if (o.angle) body.angle = o.angle;
      state.cameoPlayed = null;
    }
    tn.reveal = null;
    var data = await call(next ? "/api/musica/dj/tournament/next" : "/api/musica/dj/tournament", "POST", body);
    state.djShow = data;
    paintDjCard();
    watchPrep();
    watchHeard();
    return data;
  }

  /* While the listening windows run (A then B), poll until the vote opens. */
  function watchHeard() {
    if (state.heardTimer) return;
    var until = Date.now() + 240000;
    state.heardTimer = setInterval(async function () {
      var show = state.djShow;
      var cur = show && show.duels && show.duels.current;
      if (Date.now() > until || (cur && (cur.vote || cur.heard))) {
        clearInterval(state.heardTimer);
        state.heardTimer = null;
        if (cur && cur.heard && !cur.vote) paintDjCard();
        return;
      }
      var data = await call("/api/musica/dj/state").catch(function () { return null; });
      if (data) state.djShow = data;
      var next = data && data.duels && data.duels.current;
      if (next && (next.heard || next.vote)) { paintDjCard(); }
    }, 3000);
  }

  /* After the final: the sister's line arrives a few seconds later (recorded in the background). */
  function watchCameo() {
    if (state.cameoTimer) return;
    var tries = 0;
    state.cameoTimer = setInterval(async function () {
      tries += 1;
      var data = await call("/api/musica/dj/state").catch(function () { return null; });
      var t = data && data.tournament;
      var cameo = t && t.cameo;
      if (data) state.djShow = data;
      if ((cameo && cameo.drop) || tries > 20) {
        clearInterval(state.cameoTimer);
        state.cameoTimer = null;
        paintDjCard();
        if (cameo && cameo.drop && state.cameoPlayed !== t.id) {
          state.cameoPlayed = t.id;
          musicaSay((cameo.who === "else" ? "Else" : "Transferania") + " : " + cameo.text);
          state.cameoSaying = true;
          playDrops([cameo.drop], cameo.text, false).catch(function () {}).then(function () { state.cameoSaying = false; });
        }
      } else if (cameo && !state.cameoShown) {
        state.cameoShown = true;
        paintDjCard();
      }
    }, 2500);
  }

  /* Accueil and the moments bubble can open Musique on a given tab (one-shot hint in sessionStorage). */
  function takeTabHint() {
    var tab = "lecture";
    try {
      var hint = window.sessionStorage.getItem("hq_music_tab");
      window.sessionStorage.removeItem("hq_music_tab");
      if (["lecture", "playlists", "mixer", "decouvertes", "musica", "journal", "quiz", "studio"].indexOf(hint) >= 0) tab = hint;
    } catch (_e) { /* storage blocked: the default tab */ }
    return tab;
  }

  /* Keyboard: A / B (or 1 / 2, or the arrows) cast the vote of an open match; nothing happens while typing. */
  function bindMatchKeys() {
    if (state.matchKeysBound) return;
    state.matchKeysBound = true;
    document.addEventListener("keydown", function (ev) {
      if (!state.shown || !state.host || !state.host.isConnected || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      var t = ev.target;
      if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
      var side = { a: "a", "1": "a", ArrowLeft: "a", b: "b", "2": "b", ArrowRight: "b" }[ev.key.length === 1 ? ev.key.toLowerCase() : ev.key];
      if (!side) return;
      var pick = state.host.querySelector(".hqm-tn-arena:not(.is-listening):not(.is-chosen-a):not(.is-chosen-b) .side-" + side + " .hqm-tn-pick");
      if (!pick || pick.disabled) return;
      ev.preventDefault();
      pick.click();
    });
  }

  function seedLabel(r) { return (r.seed ? "#" + r.seed + " " : "") + r.name; }

  /* The match arena: two big sides, a VS medallion, equaliser bars while the windows play. */
  function renderTournamentVote(cur) {
    var tn = ensureTourn();
    var wait = cur.window && !cur.heard && !tn.skipped[cur.id];
    var fresh = !tn.entered["arena" + cur.id];  // entrance animation once per match, not at every repaint
    tn.entered["arena" + cur.id] = true;
    if (fresh) musicaReact(cur.repechage ? "lean" : "start");
    musicaReact(cur.window && !cur.heard && !tn.skipped[cur.id] ? "listen-on" : "listen-off");
    if (wait && !tn.windowStart[cur.id]) tn.windowStart[cur.id] = Date.now();
    var elapsed = wait ? (Date.now() - tn.windowStart[cur.id]) / 1000 : 0;
    var seconds = (cur.window || {}).seconds || 35;
    var arena = el("div", "hqm-tn-arena" + (cur.repechage ? " is-wild" : "") + (wait ? " is-listening" : "") + (fresh ? " is-enter" : ""));
    arena.setAttribute("role", "group");
    arena.setAttribute("aria-label", (cur.repechage ? "Repêchage" : cur.daily ? "Défi du jour" : "Match") + " : titre A contre titre B" +
      (cur.blind ? ", à l’aveugle" : ""));
    if (fresh) announce((cur.repechage ? "Repêchage. " : cur.daily ? "Défi du jour. " : "Nouveau match. ") + "Titre A contre titre B." +
      (wait ? " Écoute en cours, le vote s’ouvre ensuite." : " Tu peux voter."));
    var vs = el("div", "hqm-tn-vs", "VS");
    vs.setAttribute("aria-hidden", "true");
    [["a", cur.a], ["b", cur.b]].forEach(function (pair, index) {
      var side = el("div", "hqm-tn-side side-" + pair[0] + (pair[1].masked ? " is-masked" : ""));
      side.setAttribute("role", "group");
      side.setAttribute("aria-label", "Titre " + pair[0].toUpperCase() + (pair[1].seed ? ", tête de série " + pair[1].seed : "") +
        (pair[1].masked ? ", caché jusqu’au vote" : " : " + pair[1].name));
      var badge = el("span", "hqm-tn-letter", pair[0].toUpperCase());
      badge.setAttribute("aria-hidden", "true");
      side.appendChild(badge);
      if (pair[1].seed) side.appendChild(el("span", "hqm-tn-seed", "Tête de série " + pair[1].seed));
      if (!pair[1].masked && pair[1].image) {  // the cover is shown only once the song is no secret
        var cover = el("img", "hqm-tn-side-cover");
        cover.alt = "";
        applyCover(cover, pair[1].image, 96);
        side.appendChild(cover);
      }
      side.appendChild(el("strong", "hqm-tn-name", pair[1].masked ? "Titre mystère" : pair[1].name));
      side.appendChild(el("span", "hqm-tn-artist", pair[1].masked ? "révélé après ton vote" : (pair[1].artists || []).join(", ")));
      if (wait) {
        var eq = el("div", "hqm-tn-eq");
        eq.setAttribute("aria-hidden", "true");
        for (var i = 0; i < 5; i += 1) eq.appendChild(el("i"));
        side.appendChild(eq);
        // Listening progress: A runs first, B starts when A's window ends; resumes where it was after a repaint.
        var bar = el("div", "hqm-tn-progress");
        bar.setAttribute("aria-hidden", "true");
        var fill = el("i", "");
        var offset = pair[0] === "a" ? 0 : seconds;
        fill.style.animationDuration = seconds + "s";
        fill.style.animationDelay = (offset - elapsed).toFixed(2) + "s";
        bar.appendChild(fill);
        side.appendChild(bar);
      }
      var actions = el("div", "hqm-tn-actions");
      actions.appendChild(btn("🔊 Réécouter", "hqm-btn secondary", async function () {
        try { await call("/api/musica/dj/duel/listen", "POST", { side: pair[0] }); status("Extrait " + pair[0].toUpperCase() + "…"); }
        catch (err) { status(friendlyPlayerError(err), true); }
      }));
      if (!wait) {
        var pickBtn = btn("Je choisis " + pair[0].toUpperCase(), "hqm-btn hqm-tn-pick", function () {
          arena.classList.add("is-chosen-" + pair[0]);
          for (var s = 0; s < 10; s += 1) {  // a burst of sparks from the chosen side
            var spark = el("i", "hqm-tn-spark");
            spark.style.setProperty("--a", String(s * 36) + "deg");
            spark.style.setProperty("--d", String(40 + (s % 3) * 14) + "px");
            side.appendChild(spark);
          }
          djVote(pair[0]).catch(function (e) { arena.classList.remove("is-chosen-" + pair[0]); status(e.message, true); });
        });
        pickBtn.setAttribute("aria-label", "Choisir le titre " + pair[0].toUpperCase());
        pickBtn.setAttribute("aria-keyshortcuts", pair[0].toUpperCase());
        actions.appendChild(pickBtn);
      }
      side.appendChild(actions);
      arena.appendChild(side);
      if (index === 0) arena.appendChild(vs);
    });
    var wrap = el("div", "");
    wrap.appendChild(arena);
    if (wait) {
      var hint = el("p", "hqm-muted hqm-hint hqm-tn-hint");
      hint.appendChild(el("span", "hqm-tn-live", "● Écoute"));
      hint.appendChild(document.createTextNode(" A puis B, environ " + ((cur.window || {}).seconds || 35) + " secondes chacun."));
      wrap.appendChild(hint);
      wrap.appendChild(btn("Voter sans attendre", "hqm-btn secondary", function () { tn.skipped[cur.id] = true; paintDjCard(); }));
    } else {
      wrap.appendChild(el("p", "hqm-muted hqm-hint", (cur.blind ? "À l’aveugle : titres et artistes révélés après ton vote. " : "") +
        "Tranche (clavier : A ou B ; ou dis « DJ, le A / le B »)."));
    }
    return wrap;
  }

  /* After the vote: the masked cards turn over to show the songs, the winner takes the light, the loser fades. */
  function renderTournamentResult(r) {
    var tn = ensureTourn();
    var fresh = !tn.entered["res" + r.id];
    tn.entered["res" + r.id] = true;
    var wrap = el("div", "hqm-tn-result" + (r.upset ? " is-upset" : "") + (fresh ? " is-enter" : ""));
    var banner = el("span", "hqm-tn-result-kicker", r.upset ? "💥 Surprise !" : r.blind ? "🎭 Révélation" : "✔ Résultat");
    wrap.appendChild(banner);
    var arena = el("div", "hqm-tn-arena hqm-tn-arena-result");
    [["a", r.a, r.aImage], ["b", r.b, r.bImage]].forEach(function (pair, index) {
      var won = r.winner === pair[0];
      var side = el("div", "hqm-tn-side side-" + pair[0] + (won ? " is-winner" : " is-loser") + (r.blind ? " is-flip" : ""));
      side.style.setProperty("--flip-delay", (index * 0.18) + "s");
      side.appendChild(el("span", "hqm-tn-letter", pair[0].toUpperCase()));
      if (won) side.appendChild(el("span", "hqm-tn-crown-badge", "👑"));
      if (pair[2]) {
        var cover = el("img", "hqm-tn-side-cover");
        cover.alt = "";
        applyCover(cover, pair[2], 96);
        side.appendChild(cover);
      }
      var parts = String(pair[1]).split(" — ");
      side.appendChild(el("strong", "hqm-tn-name", parts[0]));
      side.appendChild(el("span", "hqm-tn-artist", parts.slice(1).join(" — ")));
      arena.appendChild(side);
    });
    wrap.appendChild(arena);
    return wrap;
  }

  /* The Quiz tab hosts the tournament: it needs the show state, and repaints itself when a match is ready. */
  function renderTournamentSection(host) {
    renderDailyCard(host);
    var card = el("section", "hqm-card hqm-tournament");
    card.appendChild(renderDjTournament(state.djShow || {}));
    card.appendChild(renderTournamentHall());
    host.appendChild(card);
  }

  function renderTournamentOptions(box) {
    var tn = ensureTourn();
    var hall = tn.hall || {};
    var rivalry = hall.rivalry || {};
    var form = el("div", "hqm-dj-tourn-options");
    var kindSelect = document.createElement("select");
    kindSelect.setAttribute("aria-label", "Type de tournoi");
    (hall.kinds || [{ id: "games", label: "Jeux vidéo" }]).forEach(function (k) {
      if (k.id !== "daily") kindSelect.appendChild(new Option(k.label, k.id));
    });
    kindSelect.value = tn.kind;
    kindSelect.addEventListener("change", function () {
      tn.kind = kindSelect.value;
      tn.opts.angle = "";
      tn.opts.theme = "";
      loadHall(tn.kind).then(function () { render(); });
    });
    form.appendChild(kindSelect);
    [["blind", "Matchs à l’aveugle (titres masqués jusqu’au vote)"],
      ["window", "Écoute de 35 s par titre (≈ 90 s par match)"],
      ["wildcard", "Repêchage avant la finale après une surprise"]].forEach(function (pair) {
      var label = el("label", "hqm-check");
      var input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!tn.opts[pair[0]];
      input.addEventListener("change", function () { tn.opts[pair[0]] = input.checked; });
      label.appendChild(input);
      label.appendChild(document.createTextNode(" " + pair[1]));
      form.appendChild(label);
    });
    if (rivalry.owner === "master") form.appendChild(el("p", "hqm-dj-duel-guess is-same", "🏅 Tu as gagné la rivalité : c’est toi qui choisis le thème !"));
    else if (rivalry.owner === "musica") form.appendChild(el("p", "hqm-muted hqm-hint", "Musica a gagné la rivalité : elle choisit le thème (laisse « au hasard » pour qu’elle décide)."));
    if (tn.kind === "library") {
      form.appendChild(el("p", "hqm-muted hqm-hint", "Huit de tes titres les plus écoutés ces 90 derniers jours, un par artiste : tu départages tes propres favoris."));
      box.appendChild(form);
      return;
    }
    var pick = document.createElement("select");
    pick.setAttribute("aria-label", "Thème du tournoi");
    pick.appendChild(new Option(rivalry.owner === "musica" ? "Le choix de Musica" : "Un thème au hasard", ""));
    (hall.angles || []).forEach(function (a) { pick.appendChild(new Option(a.label, a.id)); });
    pick.value = tn.opts.angle;
    pick.addEventListener("change", function () { tn.opts.angle = pick.value; });
    form.appendChild(pick);
    var free = document.createElement("input");
    free.type = "text";
    free.maxLength = 80;
    free.placeholder = "Ou un thème libre : « thèmes de boss », « musiques de méchants »…";
    free.setAttribute("aria-label", "Thème libre");
    free.value = tn.opts.theme;
    free.addEventListener("input", function () { tn.opts.theme = free.value; });
    form.appendChild(free);
    box.appendChild(form);
  }

  /* Round stepper: where we are in the bracket at a glance. */
  function renderTournamentSteps(t) {
    var steps = el("ol", "hqm-tn-steps");
    steps.setAttribute("aria-label", "Tours du tournoi");
    var names = (t.tree || []).map(function (r) { return r.name; });
    if (t.wild_card) names.splice(Math.max(0, names.length - 1), 0, "repêchage");
    names.forEach(function (name, i) {
      var current = !t.done && name === t.round;
      var passed = t.done || (names.indexOf(t.round) > i);
      var li = el("li", (current ? "is-current " : "") + (passed ? "is-done" : "") + (name === "repêchage" ? " is-wild" : ""));
      if (current) li.setAttribute("aria-current", "step");
      li.appendChild(el("span", "hqm-tn-step-dot", passed ? "✓" : String(i + 1)));
      li.appendChild(el("span", "hqm-tn-step-name", name));
      steps.appendChild(li);
    });
    return steps;
  }

  /* The whole bracket as a tree: winners lit, losers dimmed, the live match pulsing, the unknown as « ? ». */
  function renderBracketTree(t) {
    var tn = ensureTourn();
    var treeFresh = !tn.entered["tree" + t.id];
    tn.entered["tree" + t.id] = true;
    var grid = el("div", "hqm-tn-tree" + (treeFresh ? " is-enter" : ""));
    grid.setAttribute("role", "group");
    grid.setAttribute("aria-label", "Tableau du tournoi");
    grid.tabIndex = 0;  // keyboard users can scroll the bracket sideways
    grid.style.setProperty("--tn-cols", String((t.tree || []).length));
    (t.tree || []).forEach(function (round) {
      var col = el("div", "hqm-tn-col");
      col.appendChild(el("span", "hqm-tn-col-title", round.name));
      var liveTaken = false;
      round.matches.forEach(function (m) {
        var live = !liveTaken && !t.done && round.name === t.round && m.winner == null && !!m.a && !!m.b;
        if (live) liveTaken = true;
        var winKey = t.id + round.name + round.matches.indexOf(m) + (m.winner || "");
        var isNew = !!m.winner && !tn.seenWin[winKey];  // a freshly decided match lights up once
        if (m.winner) tn.seenWin[winKey] = true;
        var card = el("div", "hqm-tn-match" + (live ? " is-live" : "") + (m.winner ? " is-played" : "") + (isNew ? " is-new" : ""));
        card.setAttribute("role", "group");
        card.setAttribute("aria-label", round.name + " : " + (m.a ? m.a.name : "à venir") + " contre " + (m.b ? m.b.name : "à venir") +
          (m.winner ? ", gagnant : " + (m.winner === "a" ? m.a.name : m.b.name) : live ? ", en cours" : ""));
        [["a", m.a], ["b", m.b]].forEach(function (pair) {
          var side = pair[1];
          var row = el("div", "hqm-tn-row" + (m.winner === pair[0] ? " is-winner" : m.winner ? " is-loser" : "") + (!side ? " is-empty" : ""));
          row.appendChild(el("span", "hqm-tn-row-seed", side && side.seed ? String(side.seed) : "·"));
          if (side && side.image && !side.masked) {  // tiny cover, only once the song is no secret
            var thumb = el("img", "hqm-tn-row-cover");
            thumb.alt = "";
            thumb.loading = "lazy";
            applyCover(thumb, side.image, 40);
            row.appendChild(thumb);
          }
          row.appendChild(el("span", "hqm-tn-row-name", side ? side.name : "à venir"));
          card.appendChild(row);
        });
        col.appendChild(card);
      });
      grid.appendChild(col);
    });
    return grid;
  }

  /* Le Tournoi: a bracket of video game songs, one duel per match. */
  function renderDjTournament(show) {
    var tn = ensureTourn();
    var t = show.tournament;
    var box = el("div", "hqm-dj-duel hqm-dj-tournament hqm-tn");
    var hero = el("div", "hqm-tn-hero");
    var title = el("div", "hqm-tn-title");
    title.appendChild(el("span", "hqm-tn-kicker", t && !t.done ? "Tournoi en cours" : t && t.done ? "Tournoi terminé" : "Nouveau"));
    title.appendChild(el("h3", "", "Tournoi · " + ((t && t.kind_label) || KIND_LABELS[tn.kind] || KIND_LABELS.games)));
    if (t && t.angle) title.appendChild(el("span", "hqm-tn-theme", "🎮 " + t.angle));
    hero.appendChild(title);
    var rivalry = (tn.hall || {}).rivalry;
    if (rivalry && (rivalry.musica || rivalry.master)) {
      var score = el("div", "hqm-tn-score");
      score.setAttribute("aria-label", "Rivalité : Musica " + rivalry.musica + ", Maître " + rivalry.master);
      var total = Math.max(1, rivalry.musica + rivalry.master);
      var musica = el("span", "hqm-tn-score-musica", "Musica " + rivalry.musica);
      var master = el("span", "hqm-tn-score-master", rivalry.master + " Maître");
      musica.style.flexGrow = String(Math.max(0.35, rivalry.musica / total));
      master.style.flexGrow = String(Math.max(0.35, rivalry.master / total));
      score.append(musica, master);
      hero.appendChild(score);
    }
    box.appendChild(hero);
    var busy = show.prep && show.prep.running;
    var open = show.duels && show.duels.current && !show.duels.current.vote && t && show.duels.current.tournament === t.id;
    if (busy) box.appendChild(renderDjProgress(show.prep));  // also what keeps the 600 ms poll from repainting the whole tab
    if (!t) {
      box.appendChild(el("p", "hqm-muted", "Huit morceaux de jeux vidéo vérifiés sur Spotify, classés par Musica (têtes de série), " +
        "des quarts à la finale : tu écoutes deux extraits, tu tranches, et Musica commente (et te taquine) à chaque match."));
    }
    if (t) {
      box.appendChild(renderTournamentSteps(t));
      if (!t.done) {
        var line = el("p", "hqm-tn-where");
        line.appendChild(el("strong", "", "Tour " + t.round_no + "/" + t.rounds + " · " + t.round));
        line.appendChild(document.createTextNode(" · match " + t.match + "/" + t.of + (t.upsets ? " · 💥 " + t.upsets + " surprise" + (t.upsets > 1 ? "s" : "") : "")));
        box.appendChild(line);
      }
      if (tn.reveal && !tn.reveal.daily && !open) box.appendChild(renderTournamentResult(tn.reveal));
      if (t.wild_card && t.wild_card.pending) {
        box.appendChild(el("p", "hqm-tn-callout is-wild", "🃏 Repêchage : " + t.wild_card.name +
          (t.wild_card.by ? " (éliminé par " + t.wild_card.by + ")" : "") + " revient défier un finaliste."));
      } else if (t.wild_card && t.wild_card.won != null) {
        box.appendChild(el("p", "hqm-muted hqm-hint", t.wild_card.won ? "🃏 Le wild card a gagné sa place en finale." : "🃏 Le wild card n’a pas réussi son retour."));
      }
      if (open) box.appendChild(renderTournamentVote(show.duels.current));
      box.appendChild(renderBracketTree(t));
      var notes = [];
      if (t.theme_note) notes.push(t.theme_note);
      if (t.source === "spotify") notes.push("Recherche web indisponible : sélection Spotify, moins précise.");
      else if (t.source === "mixed") notes.push("Complétée par une recherche Spotify.");
      if (t.reused) notes.push(t.reused + " titre(s) déjà vu(s) lors d’un tournoi précédent, faute de nouveautés.");
      if (t.upsets_called) notes.push(t.upsets_called + " surprise(s) annoncée(s) par Musica.");
      if (notes.length) box.appendChild(el("p", "hqm-muted hqm-hint", notes.join(" ")));
      if (t.done && t.champion) {
        var champFresh = !tn.entered["champ" + t.id];  // the celebration plays once, not at every repaint
        tn.entered["champ" + t.id] = true;
        var champ = el("div", "hqm-tn-champion" + (champFresh ? " is-enter" : ""));
        if (champFresh) {
          for (var c = 0; c < 34; c += 1) {
            var piece = el("i", "hqm-tn-confetti c" + (c % 7));
            piece.style.left = (Math.random() * 100).toFixed(1) + "%";
            piece.style.animationDelay = (Math.random() * 0.9).toFixed(2) + "s";
            piece.style.animationDuration = (2.2 + Math.random() * 1.6).toFixed(2) + "s";
            piece.style.setProperty("--drift", ((Math.random() - 0.5) * 120).toFixed(0) + "px");
            champ.appendChild(piece);
          }
        }
        var cover = el("img", "hqm-tn-cover");
        cover.alt = "";
        applyCover(cover, t.champion.image, 96);
        champ.appendChild(cover);
        var words = el("div", "hqm-tn-champion-words");
        words.appendChild(el("span", "hqm-tn-crown", "🏆 Vainqueur du tournoi"));
        words.appendChild(el("strong", "", t.champion.name));
        words.appendChild(el("span", "hqm-muted", (t.champion.artists || [])[0] || ""));
        champ.appendChild(words);
        box.appendChild(champ);
        if (champFresh) setTimeout(function () { champ.querySelectorAll(".hqm-tn-confetti").forEach(function (n) { n.remove(); }); }, 5200);
        var guess = t.prediction;
        if (guess) {
          box.appendChild(el("p", "hqm-tn-callout " + (guess.same ? "is-same" : "is-gap"),
            guess.same ? "🎯 Le pronostic secret de Musica était le même : " + guess.name + ". Vous pensez pareil."
              : "🎲 Le pronostic secret de Musica : " + guess.name + (guess.out_round ? ", sorti en " + guess.out_round +
                (guess.out_by ? " (battu par " + guess.out_by + ")" : "") : "") + ". Vous n’avez pas les mêmes oreilles."));
        }
        if (t.cameo) {
          box.appendChild(el("p", "hqm-tn-callout is-cameo", "🎤 " + (t.cameo.who === "else" ? "Else" : "Transferania") + " : « " + t.cameo.text + " »"));
        }
        cardButton(box, "🖼 Carte de partage", function () { return shareCard(t); });
      } else if (!open && !busy) {
        var next = cardButton(box, t.wild_card && t.wild_card.pending ? "▶ Lancer le repêchage" : "▶ Match suivant", function () { return djTournament(true); });
        next.classList.add("hqm-tn-next");
        next.classList.remove("secondary");
      }
    }
    if (!busy && (!t || t.done)) {
      renderTournamentOptions(box);
      var go = btn(t ? "🎮 Nouveau tournoi" : "🎮 Lancer un tournoi jeux vidéo", "hqm-dj-launch hqm-tn-launch", function () {
        go.disabled = true;
        djTournament(false).catch(function (e) { status(e.message, true); go.disabled = false; });
      });
      box.appendChild(go);
    }
    return box;
  }

  /* Hall of fame, all-time ranking and the rivalry with Musica. */
  function renderTournamentHall() {
    var hall = ensureTourn().hall;
    var box = el("details", "hqm-advanced hqm-dj-hall");
    var summary = document.createElement("summary");
    summary.textContent = "Palmarès · classement de tous les temps";
    box.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    box.appendChild(body);
    if (ensureTourn().hallError && !hall) {
      body.appendChild(el("p", "hqm-muted", "Palmarès indisponible pour le moment : il reviendra au prochain chargement."));
      return box;
    }
    if (!hall || !hall.played) {
      body.appendChild(el("p", "hqm-muted", "Le palmarès se construit au fil des tournois : vainqueurs, classement de tes votes, titres les plus souvent éliminés."));
      return box;
    }
    var rival = hall.rivalry || {};
    body.appendChild(el("p", "", "Rivalité : Musica " + rival.musica + " – " + rival.master + " Maître" +
      (rival.streak && rival.streak.n > 1 ? " · " + rival.streak.n + " d’affilée pour " + (rival.streak.who === "master" ? "toi" : "Musica") : "") + "."));
    function section(title, rows, fmt) {
      if (!rows || !rows.length) return;
      body.appendChild(el("strong", "hqm-dj-label", title));
      var ol = el("ol", "hqm-dj-tracks");
      rows.forEach(function (r) { ol.appendChild(el("li", "", fmt(r))); });
      body.appendChild(ol);
    }
    section("Vainqueurs", hall.champions, function (c) { return c.name + " — " + c.artist + " (" + c.angle + (c.pick_same ? " · pronostic de Musica ✓" : "") + ")"; });
    section("Ton classement", hall.ranking, function (r) { return r.name + " — " + r.artist + " · " + r.wins + " victoires, " + r.losses + " défaites" + (r.titles ? ", " + r.titles + " titre(s)" : ""); });
    section("Souvent éliminés", hall.most_eliminated, function (r) { return r.name + " — " + r.artist + " · " + r.losses + " fois"; });
    section("Compositeurs en finale", hall.artists, function (a) { return a.name + " · " + a.finals + " finale(s), " + a.titles + " titre(s)"; });
    return box;
  }

  /* Cut a canvas line with an ellipsis so it never runs past the card. */
  function fitText(ctx, text, maxWidth) {
    if (ctx.measureText(text).width <= maxWidth) return text;
    var cut = text;
    while (cut.length > 1 && ctx.measureText(cut + "…").width > maxWidth) cut = cut.slice(0, -1);
    return cut + "…";
  }

  /* Share card: the bracket and the champion drawn on a canvas, saved or shared as a PNG. */
  async function shareCard(t) {
    var W = 1080, H = 1350;
    var canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext("2d");
    var grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, "#1b1035"); grad.addColorStop(1, "#5b1d6b");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = "#fbbf24"; ctx.font = "700 34px system-ui, sans-serif";
    ctx.fillText("DJ MUSICA · TOURNOI " + String(t.kind_label || "jeux vidéo").toUpperCase(), 60, 90);
    ctx.fillStyle = "#ffffff"; ctx.font = "600 30px system-ui, sans-serif";
    ctx.fillText(t.angle || "", 60, 140);
    var champ = t.champion || {};
    if (champ.image) {
      try {
        var img = await new Promise(function (resolve, reject) {
          var i = new Image();
          i.onload = function () { resolve(i); };
          i.onerror = reject;
          i.src = coverSrc(champ.image, 640);
        });
        ctx.drawImage(img, 60, 190, 360, 360);
      } catch (_e) {}
    }
    ctx.fillStyle = "#fbbf24"; ctx.font = "700 30px system-ui, sans-serif";
    ctx.fillText("🏆 VAINQUEUR", 460, 250);
    ctx.fillStyle = "#ffffff"; ctx.font = "700 52px system-ui, sans-serif";
    wrapText(ctx, champ.name || "", 460, 320, 560, 60);
    ctx.font = "400 32px system-ui, sans-serif"; ctx.fillStyle = "#e9d5ff";
    ctx.fillText((champ.artists || [])[0] || "", 460, 470);
    ctx.font = "600 30px system-ui, sans-serif"; ctx.fillStyle = "#ffffff";
    ctx.fillText("Le tableau (têtes de série de Musica)", 60, 640);
    ctx.font = "400 30px system-ui, sans-serif";
    var seedList = t.seeds || [];
    var thumbs = await Promise.all(seedList.map(function (r) {  // a failed cover just leaves the row without one
      return r.image ? new Promise(function (resolve) {
        var i = new Image();
        i.onload = function () { resolve(i); };
        i.onerror = function () { resolve(null); };
        i.src = coverSrc(r.image, 96);
      }) : Promise.resolve(null);
    }));
    seedList.forEach(function (r, i) {
      var isChamp = r.uri && champ.uri === r.uri;
      var y = 700 + i * 52;
      if (thumbs[i]) ctx.drawImage(thumbs[i], 60, y - 34, 42, 42);
      ctx.fillStyle = isChamp ? "#fbbf24" : "#e9d5ff";
      var rowX = thumbs[i] ? 114 : 60;
      ctx.fillText(fitText(ctx, "#" + r.seed + "  " + r.name + ((r.artists || [])[0] ? " — " + r.artists[0] : "") + (isChamp ? "  🏆" : ""), 1020 - rowX), rowX, y);
    });
    var guess = t.prediction;
    ctx.fillStyle = "#ffffff"; ctx.font = "600 30px system-ui, sans-serif";
    if (guess) wrapText(ctx, guess.same ? "🎯 Musica l’avait prédit : " + guess.name
      : "🎲 Musica pariait sur " + guess.name + (guess.out_round ? " (sorti en " + guess.out_round + ")" : ""), 60, 1170, 960, 40);
    var rival = (ensureTourn().hall || {}).rivalry;
    if (rival) { ctx.fillStyle = "#fbbf24"; ctx.fillText("Rivalité · Musica " + rival.musica + " – " + rival.master + " Maître", 60, 1280); }
    var blob = await new Promise(function (resolve) { canvas.toBlob(resolve, "image/png"); });
    if (!blob) throw new Error("Image indisponible");
    var file = new File([blob], "tournoi-musica.png", { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "Tournoi DJ Musica" }); return; } catch (_e) { /* cancelled: download instead */ }
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "tournoi-musica.png";
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    status("Carte enregistrée.");
  }

  function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
    var words = String(text).split(/\s+/), line = "";
    words.forEach(function (word) {
      var test = line ? line + " " + word : word;
      if (ctx.measureText(test).width > maxWidth && line) { ctx.fillText(line, x, y); line = word; y += lineHeight; }
      else line = test;
    });
    if (line) ctx.fillText(line, x, y);
  }

  /* Rembobiner: past shows, replayable with the same lines. */
  function renderDjArchive() {
    var box = el("details", "hqm-advanced hqm-dj-archive");
    var summary = document.createElement("summary");
    summary.textContent = "Rembobiner · émissions passées";
    box.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    box.appendChild(body);
    var loaded = false;
    box.addEventListener("toggle", function () {
      if (!box.open || loaded) return;
      loaded = true;
      body.appendChild(el("p", "hqm-muted", "Chargement…"));
      call("/api/musica/dj/archive").then(function (data) {
        body.textContent = "";
        var episodes = data.episodes || [];
        if (!episodes.length) {
          body.appendChild(el("p", "hqm-muted", "Pas encore d’émission gardée : chaque segment passé à l’antenne apparaîtra ici."));
          return;
        }
        episodes.forEach(function (ep) {
          var row = el("div", "hqm-dj-episode");
          var meta = el("div", "hqm-track-meta");
          var when = ep.started ? new Date(ep.started * 1000).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "";
          meta.appendChild(el("strong", "", (ep.title || "Émission") + (ep.segments.length > 1 ? " +" + (ep.segments.length - 1) : "")));
          meta.appendChild(el("span", "hqm-muted", when + " · " + ep.tracks + " titres"));
          var names = [];
          ep.segments.forEach(function (s) { (s.tracks || []).forEach(function (t) { if (names.length < 4) names.push(t.name); }); });
          meta.appendChild(el("span", "hqm-reason", names.join(" · ")));
          row.appendChild(meta);
          cardButton(row, "↺ Rejouer cette émission", async function () {
            unlockAudio();
            state.prepDisplay = 2;
            state.djShow = await call("/api/musica/dj/archive/replay", "POST", { id: ep.id, device_id: state.preferredDeviceId || undefined });
            paintDjCard();
            watchPrep();
          });
          body.appendChild(row);
        });
      }).catch(function (e) { body.textContent = ""; body.appendChild(el("p", "hqm-muted", e.message || "Archives indisponibles.")); });
    });
    return box;
  }

  /* Her bets: one track per segment she defends; finished = won, skipped in the first seconds = lost. */
  function renderDjPicks(picks) {
    var box = el("div", "hqm-dj-picks");
    var wins = picks.wins || 0;
    var losses = picks.losses || 0;
    var head = el("div", "hqm-dj-picks-head");
    head.appendChild(el("span", "hqm-dj-label", "Les paris de Musica"));
    var score = el("strong", "hqm-dj-picks-score", wins + " ✓ · " + losses + " ✗");
    head.appendChild(score);
    var streak = picks.streak || 0;
    if (streak > 1) head.appendChild(el("span", "hqm-chip is-static", streak + " d’affilée 🔥"));
    else if (streak < -1) head.appendChild(el("span", "hqm-chip is-static", -streak + " ratés d’affilée"));
    box.appendChild(head);
    if (!wins && !losses) {
      box.appendChild(el("p", "hqm-muted", "Chaque segment, elle parie sur un titre qu’elle aime. Écoute-le jusqu’au bout : pari gagné. Zappe-le : pari perdu."));
      return box;
    }
    var list = el("div", "hqm-preset-row");
    (picks.recent || []).forEach(function (h) {
      list.appendChild(el("span", "hqm-chip is-static hqm-dj-pick-chip is-" + h.result,
        (h.result === "won" ? "✓ " : "✗ ") + h.name + (h.artist ? " — " + h.artist : "")));
    });
    box.appendChild(list);
    return box;
  }

  function renderDjLearned(learned) {
    var box = el("details", "hqm-advanced hqm-dj-learned");
    var summary = document.createElement("summary");
    summary.textContent = "Ce que j’ai appris";
    box.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    var any = false;
    function line(label, items) {
      if (!items || !items.length) return;
      any = true;
      var row = el("div", "hqm-dj-learned-row");
      row.appendChild(el("span", "hqm-muted", label));
      var chips = el("div", "hqm-preset-row");
      items.forEach(function (text) { chips.appendChild(el("span", "hqm-chip is-static", text)); });
      row.appendChild(chips);
      body.appendChild(row);
    }
    line("Tu adores", (learned.artists || []).slice(0, 10).map(function (a) { return a.name; }));
    line("Tu t’en lasses un peu", (learned.cooling || []).map(function (a) { return a.name; }));
    Object.keys(learned.dayparts || {}).forEach(function (part) {
      line("Le/la " + part, learned.dayparts[part]);
    });
    line("Tu écoutes jusqu’au bout", learned.pools_liked);
    line("Tu zappes souvent", learned.pools_skipped);
    line("Tes dernières demandes", (learned.steers || []).slice(-5).map(function (st) { return st.text + " (" + st.part + ")"; }));
    if (!any) body.appendChild(el("p", "hqm-muted",
      "Pas encore grand-chose : j’apprends avec ton journal, tes « j’aime », les titres que tu écoutes jusqu’au bout, tes zappings et tes demandes."));
    body.appendChild(el("p", "hqm-muted hqm-hint",
      "Tout reste sur ce PC ; envoyé à l’IA seulement si le partage de l’historique est activé. Réinitialiser efface ce que l’émission a appris (zappings, écoutes complètes, demandes, blagues), pas ton journal ni tes « j’aime »."));
    var reset = el("div", "hqm-row");
    cardButton(reset, "Réinitialiser ce que j’ai appris", async function () {
      if (!window.confirm("Effacer ce que DJ Musica a appris pendant ses émissions ?")) return;
      state.djShow = await call("/api/musica/dj/learned/reset", "POST", {});
      status("DJ Musica repart de zéro sur ses émissions.");
      paintDjCard();
    });
    body.appendChild(reset);
    box.appendChild(body);
    return box;
  }

  function renderDjSettings(host) {
    var card = el("div", "hqm-dj-body");
    card.appendChild(el("p", "hqm-muted",
      "Quand tu lances ta propre musique, Musica peut quand même glisser une courte phrase au changement de morceau. " +
      "Réglage propre à cet appareil ; actif tant que Musique est ouvert."));
    var row = el("div", "hqm-row hqm-dj-row");
    var toggleLabel = el("label", "hqm-check");
    var toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = !!state.dj.on;
    toggle.addEventListener("change", function () {
      state.dj.on = toggle.checked;
      state.djCount = 0;
      saveDj();
      status(state.dj.on ? "Annonces hors émission activées." : "Annonces hors émission coupées.");
      paintDockBadges();
    });
    toggleLabel.append(toggle, " Annoncer aussi ma propre musique");
    row.appendChild(toggleLabel);
    var every = document.createElement("select");
    every.setAttribute("aria-label", "Fréquence des interventions");
    [[1, "À chaque morceau"], [2, "Un morceau sur 2"], [3, "Un morceau sur 3"], [5, "Un morceau sur 5"]].forEach(function (pair) {
      every.appendChild(new Option(pair[1], String(pair[0])));
    });
    every.value = String(state.dj.every);
    every.addEventListener("change", function () { state.dj.every = Number(every.value) || 3; saveDj(); });
    row.appendChild(every);
    var style = document.createElement("select");
    style.setAttribute("aria-label", "Style des interventions");
    [["annonce", "Annonce"], ["anecdote", "Annonce + anecdote"], ["transition", "Transition"]].forEach(function (pair) {
      style.appendChild(new Option(pair[1], pair[0]));
    });
    style.value = state.dj.style;
    style.addEventListener("change", function () { state.dj.style = style.value; saveDj(); });
    row.appendChild(style);
    card.appendChild(row);
    host.appendChild(card);
  }

  /* Minuteur de sommeil : fondu du volume sur la dernière minute, pause, puis volume d’origine rétabli. */
  function sleepLeftMs() {
    return state.sleep ? Math.max(0, state.sleep.endAt - Date.now()) : 0;
  }

  function startSleep(minutes) {
    cancelSleep(true);
    var endAt;
    if (minutes === "track") {
      var item = state.player && state.player.item;
      if (!item || !item.duration_ms) { status("Rien en lecture pour caler le minuteur.", true); return; }
      endAt = Date.now() + Math.max(4000, item.duration_ms - estimatedProgressMs() - 1500);
    } else {
      endAt = Date.now() + minutes * 60000;
    }
    state.sleep = { endAt: endAt, fading: false, mode: minutes };
    state.sleep.timer = setInterval(sleepTick, 1000);
    paintDockBadges();
    status("Minuteur : arrêt vers " + new Date(endAt).toLocaleTimeString("fr-CA", { hour: "2-digit", minute: "2-digit" }) + ".");
  }

  function setVolume(deviceId, level) {
    return call("/api/spotify/player", "POST", {
      action: "volume", device_id: deviceId, volume_percent: Math.max(0, Math.min(100, Math.round(level))), auto_device: false
    });
  }

  function cancelSleep(silent) {
    var current = state.sleep;
    if (!current) return;
    clearInterval(current.timer);
    state.sleep = null;
    if (current.device && current.fading) {
      setVolume(current.device.id, current.device.volume).catch(function () {});
    }
    paintDockBadges();
    if (!silent) status("Minuteur annulé.");
  }

  function sleepTick() {
    var current = state.sleep;
    if (!current) return;
    paintDockBadges();
    var left = sleepLeftMs();
    if (!current.fading && left <= Math.min(FADE_MS, current.mode === "track" ? 15000 : FADE_MS)) {
      current.fading = true;
      runFade(current).catch(function () {});
    }
  }

  async function runFade(current) {
    var player = await call("/api/spotify/player").catch(function () { return null; });
    var device = player && player.device;
    if (device && device.id && Number.isFinite(device.volume_percent)) {
      current.device = { id: device.id, volume: device.volume_percent };
      var steps = 8;
      for (var i = 1; i <= steps; i += 1) {
        if (state.sleep !== current) return;
        var wait = Math.max(300, (current.endAt - Date.now()) / (steps - i + 1));
        await new Promise(function (resolve) { setTimeout(resolve, wait); });
        if (state.sleep !== current) return;
        await setVolume(device.id, current.device.volume * (1 - i / steps)).catch(function () {});
      }
    } else {
      await new Promise(function (resolve) { setTimeout(resolve, Math.max(0, current.endAt - Date.now())); });
    }
    if (state.sleep !== current) return;
    try {
      await call("/api/spotify/player", "POST", { action: "pause", auto_device: false,
        device_id: current.device ? current.device.id : undefined });
    } catch (_e) {}
    if (current.device) await setVolume(current.device.id, current.device.volume).catch(function () {});
    clearInterval(current.timer);
    state.sleep = null;
    paintDockBadges();
    refreshPlayer(true).catch(function () {});
    status("Minuteur terminé — bonne nuit, Maître.");
  }

  function sleepMenu() {
    var items = [15, 30, 45, 60].map(function (minutes) {
      return { label: minutes + " min", run: function () { startSleep(minutes); } };
    });
    items.push({ label: "Fin du morceau", run: function () { startSleep("track"); } });
    if (state.sleep) items.push({ label: "Annuler le minuteur", danger: true, run: function () { cancelSleep(false); } });
    return menuButton("Minuteur de sommeil", items, "is-inline hqm-sleep-menu");
  }

  function paintDockBadges() {
    if (!state.host) return;
    var left = sleepLeftMs();
    state.host.querySelectorAll("[data-hqm='sleep-chip']").forEach(function (chip) {
      chip.hidden = !state.sleep;
      if (state.sleep) {
        var m = Math.floor(left / 60000), sec = Math.floor((left % 60000) / 1000);
        chip.textContent = "☾ " + m + ":" + String(sec).padStart(2, "0");
        chip.title = "Minuteur de sommeil — cliquer pour annuler";
      }
    });
    var onAir = !!(state.djShow && state.djShow.active);
    state.host.querySelectorAll("[data-hqm='dj-chip']").forEach(function (chip) {
      chip.hidden = !(onAir || (state.dj && state.dj.on));
      chip.textContent = onAir ? "● DJ" : "DJ";
      chip.title = onAir ? "DJ Musica en ondes" : "Annonces DJ actives";
    });
  }

  /* Teinte tirée de la pochette (proxy même origine : le canvas reste lisible). */
  function applyTint(url) {
    if (!state.host) return;
    if (!url) {
      state.tintKey = "";
      state.host.classList.remove("has-tint");
      return;
    }
    if (state.tintKey === url) return;
    state.tintKey = url;
    var img = new Image();
    img.decoding = "async";
    img.onload = function () {
      if (state.tintKey !== url || !state.host) return;
      try {
        var size = 24;
        var canvas = document.createElement("canvas");
        canvas.width = canvas.height = size;
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, size, size);
        var data = ctx.getImageData(0, 0, size, size).data;
        var r = 0, g = 0, b = 0, total = 0;
        for (var i = 0; i < data.length; i += 4) {
          var max = Math.max(data[i], data[i + 1], data[i + 2]), min = Math.min(data[i], data[i + 1], data[i + 2]);
          var sat = max ? (max - min) / max : 0;
          var weight = sat * sat * (max / 255) + 0.02;
          r += data[i] * weight; g += data[i + 1] * weight; b += data[i + 2] * weight; total += weight;
        }
        var rgb = tintNormalize(r / total, g / total, b / total);
        state.host.style.setProperty("--hqm-tint", "rgb(" + rgb.join(" ") + ")");
        state.host.classList.add("has-tint");
      } catch (_e) {
        state.host.classList.remove("has-tint");
      }
    };
    img.onerror = function () { if (state.host) state.host.classList.remove("has-tint"); };
    img.src = coverSrc(url, 64);
  }

  function tintNormalize(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), h = 0, s, l = (max + min) / 2;
    var d = max - min;
    if (d) {
      h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    s = d ? d / (1 - Math.abs(2 * l - 1)) : 0;
    s = Math.max(0.38, Math.min(0.85, s));
    l = Math.max(0.52, Math.min(0.66, l));
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = l - c / 2;
    var out = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
    return out.map(function (v) { return Math.round((v + m) * 255); });
  }

  /* File d’attente : rafraîchie à chaque changement de morceau quand Lecture est ouvert. */
  function fillQueue(body) {
    if (blindMasking()) {  // a blind match is open: the queue would name the songs
      body.replaceChildren(el("p", "hqm-muted", "File masquée pendant le match à l’aveugle."));
      return Promise.resolve();
    }
    return call("/api/spotify/queue").then(function (data) {
      if (!state.shown || state.tab !== "lecture" || !body.isConnected) return;
      body.replaceChildren();
      var list = el("ul", "hqm-list");
      (data.queue || []).slice(0, 20).forEach(function (track) {
        var li = el("li", "");
        var info = el("div", "hqm-track-meta");
        info.appendChild(el("strong", "", track.name || "?"));
        info.appendChild(el("span", "", (track.artists || []).join(", ")));
        li.appendChild(info);
        list.appendChild(li);
      });
      if (!(data.queue || []).length) list.appendChild(el("li", "hqm-muted", "Rien dans la file."));
      body.appendChild(list);
      body.appendChild(el("p", "hqm-muted hqm-hint",
        "Ajoute des titres avec « + File » sur les cartes. Spotify ne permet ni de réordonner ni de retirer."));
    }).catch(function () {
      if (body.isConnected) body.replaceChildren(el("p", "hqm-muted", "File indisponible pour le moment."));
    });
  }

  function refreshQueueCard() {
    var body = state.host && state.host.querySelector(".hqm-queue .hqm-disclosure-body");
    if (body) fillQueue(body);
  }

  /* Journal d’écoute + bilan mensuel. */
  async function loadJournal(month) {
    var data = await call("/api/music/journal" + (month ? "/" + encodeURIComponent(month) : ""));
    state.journal = data.recap;
    return state.journal;
  }

  function monthLabel(month) {
    var parts = String(month || "").split("-");
    if (parts.length !== 2) return month || "";
    var label = new Date(Number(parts[0]), Number(parts[1]) - 1, 1).toLocaleDateString("fr-CA", { month: "long", year: "numeric" });
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  function dayLabel(iso) {
    if (!iso) return "?";
    var d = new Date(iso);
    return isNaN(d) ? String(iso).slice(0, 10) : d.toLocaleDateString("fr-CA", { day: "numeric", month: "long", year: "numeric" });
  }

  function statTile(value, label) {
    var tile = el("div", "hqm-stat");
    tile.appendChild(el("strong", "", String(value)));
    tile.appendChild(el("span", "", label));
    return tile;
  }

  function loadWeekly() {
    return call("/api/musica/dj/weekly")
      .then(function (data) { state.weekly = data; return data; })
      .catch(function (err) { state.weekly = { ok: false, error: err.message }; return state.weekly; });
  }

  function watchWeekly() {
    if (state.weeklyTimer) return;
    state.weeklyTimer = setTimeout(function () {
      state.weeklyTimer = null;
      loadWeekly().then(function (data) {
        if (state.tab === "journal") render();
        var job = data.job || {};
        if (job.running) watchWeekly();
        else if (job.error) status(job.error, true);
        else if (data.latest) status("Ton récap audio de la semaine est prêt.");
      });
    }, 3000);
  }

  /* One audio element for the episode, moved between renders so a re-render never cuts playback. */
  function weeklyAudio(url) {
    var audio = state.weeklyAudio;
    if (!audio) {
      audio = state.weeklyAudio = document.createElement("audio");
      audio.controls = true;
      audio.preload = "none";
      audio.className = "hqm-weekly-audio";
      audio.addEventListener("play", function () {
        if (state.player && state.player.is_playing) {
          call("/api/spotify/player", "POST", { action: "pause", auto_device: false }).catch(function () {});
        }
      });
    }
    if (audio.getAttribute("src") !== url) audio.setAttribute("src", url);
    return audio;
  }

  function renderWeeklyRecap(host) {
    var data = state.weekly;
    var card = el("section", "hqm-card hqm-weekly");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Récap audio de la semaine"));
    copy.appendChild(el("p", "hqm-muted", "Musica raconte ta semaine en musique en trois minutes, à partir de ton journal d’écoute."));
    head.appendChild(copy);
    card.appendChild(head);
    host.appendChild(card);
    if (!data) {
      card.appendChild(skeletonDetail());
      loadWeekly().then(function () { if (state.tab === "journal") render(); });
      return;
    }
    if (data.ok === false) {
      card.appendChild(el("p", "hqm-muted", data.error || "Récap indisponible."));
      return;
    }
    var job = data.job || {};
    var latest = data.latest;
    if (job.running) {
      var bar = el("div", "hqm-weekly-progress");
      var fill = el("span", "");
      fill.style.width = Math.max(4, Math.min(100, job.pct || 0)) + "%";
      bar.appendChild(fill);
      card.appendChild(bar);
      card.appendChild(el("p", "hqm-muted", job.stage || "Je prépare l’épisode…"));
      watchWeekly();
    } else if (job.error) {
      card.appendChild(el("p", "hqm-status is-error", job.error));
    }
    if (latest) {
      var episode = el("div", "hqm-weekly-episode");
      episode.appendChild(el("strong", "", latest.title || "Ta semaine en musique"));
      var secs = latest.seconds || 0;
      var stats = latest.stats || {};
      episode.appendChild(el("span", "hqm-muted", "Du " + dayLabel(stats.from) + " au " + dayLabel(stats.to) +
        (secs ? " · " + Math.floor(secs / 60) + " min " + String(secs % 60).padStart(2, "0") : "") +
        " · voix " + (latest.engine === "chatterbox" ? "Chatterbox" : "Phonon")));
      episode.appendChild(weeklyAudio(latest.audio_url));
      var tiles = el("div", "hqm-stat-grid");
      tiles.appendChild(statTile(stats.plays || 0, "écoutes"));
      tiles.appendChild(statTile(Math.round((stats.minutes || 0) / 6) / 10 + " h", "de musique"));
      tiles.appendChild(statTile(stats.active_days || 0, "jours actifs"));
      if ((stats.top_artists || [])[0]) tiles.appendChild(statTile(stats.top_artists[0].name, "artiste de la semaine"));
      episode.appendChild(tiles);
      var transcript = document.createElement("details");
      transcript.appendChild(el("summary", "", "Transcription"));
      (latest.parts || []).forEach(function (line) { transcript.appendChild(el("p", "", line)); });
      episode.appendChild(transcript);
      card.appendChild(episode);
    } else if (!job.running) {
      card.appendChild(el("p", "hqm-muted", "Pas encore d’épisode. Il faut au moins cinq écoutes dans les sept derniers jours."));
    }
    var row = el("div", "hqm-row");
    if (!job.running) {
      var fresh = latest && latest.week === data.this_week;
      cardButton(row, fresh ? "Refaire l’épisode" : "Préparer le récap maintenant", async function () {
        state.weekly = await call("/api/musica/dj/weekly", "POST", { force: !!fresh });
        render();
        watchWeekly();
      });
    }
    var auto = el("label", "hqm-check");
    var box = document.createElement("input");
    box.type = "checkbox";
    box.checked = data.enabled !== false;
    box.addEventListener("change", function () {
      call("/api/musica/dj/settings", "POST", { weekly_audio: box.checked })
        .then(function () { data.enabled = box.checked; status(box.checked ? "Récap audio chaque dimanche." : "Récap audio automatique en pause."); })
        .catch(function (e) { box.checked = !box.checked; status(e.message, true); });
    });
    auto.append(box, " Chaque dimanche dès 10 h (notification quand il est prêt)");
    row.appendChild(auto);
    card.appendChild(row);
  }

  function renderJournal(host) {
    var recap = state.journal;
    var card = el("section", "hqm-card hqm-journal");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Journal d’écoute"));
    copy.appendChild(el("p", "hqm-muted",
      "HQ garde chaque écoute Spotify bien au-delà des 50 dont Spotify se souvient (relevé toutes les 20 min, pont allumé). Tout reste sur ce PC."));
    head.appendChild(copy);
    var tools = el("div", "hqm-row");
    if (recap && (recap.months || []).length) {
      var picker = document.createElement("select");
      picker.setAttribute("aria-label", "Mois du bilan");
      var months = recap.months.indexOf(recap.month) >= 0 ? recap.months : [recap.month].concat(recap.months);
      months.forEach(function (month) { picker.appendChild(new Option(monthLabel(month), month)); });
      picker.value = recap.month;
      picker.addEventListener("change", function () {
        loadJournal(picker.value).then(render).catch(function (e) { status(e.message, true); });
      });
      tools.appendChild(picker);
    }
    cardButton(tools, "Relever maintenant", async function () {
      var data = await call("/api/music/journal/sync", "POST", {});
      var sync = data.sync || {};
      status(sync.skipped === "recent" ? "Relevé déjà fait il y a peu." :
        sync.skipped === "disabled" ? "Le journal est en pause." :
          sync.code ? "Spotify indisponible (" + sync.code + ")." : (sync.added || 0) + " écoute(s) ajoutée(s).");
      await loadJournal(recap && recap.month);
      render();
    });
    head.appendChild(tools);
    card.appendChild(head);
    if (!recap) {
      card.appendChild(skeletonDetail());
      host.appendChild(card);
      return;
    }
    var enabledLabel = el("label", "hqm-check");
    var enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = recap.settings ? recap.settings.enabled !== false : true;
    enabled.addEventListener("change", function () {
      call("/api/music/journal/settings", "POST", { enabled: enabled.checked })
        .then(function () { status(enabled.checked ? "Journal actif." : "Journal en pause (rien n’est effacé)."); })
        .catch(function (e) { enabled.checked = !enabled.checked; status(e.message, true); });
    });
    enabledLabel.append(enabled, " Tenir le journal");
    card.appendChild(enabledLabel);
    if (recap.settings && recap.settings.since) {
      card.appendChild(el("p", "hqm-muted hqm-hint", "Journal tenu depuis le " + dayLabel(recap.settings.since) + "."));
    }
    host.appendChild(card);

    var summary = el("section", "hqm-card");
    summary.appendChild(el("h3", "", monthLabel(recap.month)));
    if (!recap.plays) {
      summary.appendChild(el("p", "hqm-muted", "Aucune écoute relevée ce mois-ci pour l’instant. Le journal se remplit tout seul."));
      host.appendChild(summary);
      return;
    }
    var tiles = el("div", "hqm-stat-grid");
    tiles.appendChild(statTile(recap.plays, "écoutes"));
    tiles.appendChild(statTile(recap.minutes >= 120 ? Math.round(recap.minutes / 60) + " h" : recap.minutes + " min", "d’écoute"));
    tiles.appendChild(statTile(recap.active_days, "jours actifs"));
    tiles.appendChild(statTile(recap.longest_streak + " j", "plus longue série"));
    tiles.appendChild(statTile(recap.current_streak + " j", "série en cours"));
    tiles.appendChild(statTile(recap.distinct_artists, "artistes"));
    tiles.appendChild(statTile(recap.new_artists_count, "nouveaux artistes"));
    summary.appendChild(tiles);
    if (recap.busiest) {
      summary.appendChild(el("p", "hqm-muted", "Ton créneau favori : le " + WEEKDAYS_LONG[recap.busiest.weekday] +
        " vers " + recap.busiest.hour + " h."));
    }
    host.appendChild(summary);

    var tops = el("div", "hqm-grid-2 hqm-journal-tops");
    var artistsCard = el("section", "hqm-card");
    artistsCard.appendChild(el("h3", "", "Top artistes"));
    var maxA = Math.max.apply(null, (recap.top_artists || []).map(function (a) { return a.plays; }).concat([1]));
    var aList = el("ol", "hqm-rank");
    (recap.top_artists || []).forEach(function (artist) {
      var li = el("li", "");
      var name = btn(artist.name, "hqm-link-btn", function () { openArtist({ name: artist.name }); });
      li.appendChild(name);
      li.appendChild(el("span", "hqm-muted", artist.plays + " écoute" + (artist.plays > 1 ? "s" : "") +
        (artist.first_heard ? " · 1re le " + dayLabel(artist.first_heard) : "")));
      var bar = el("span", "hqm-rank-bar");
      bar.style.setProperty("--w", Math.round(artist.plays / maxA * 100) + "%");
      li.appendChild(bar);
      aList.appendChild(li);
    });
    artistsCard.appendChild(aList);
    tops.appendChild(artistsCard);
    var tracksCard = el("section", "hqm-card");
    tracksCard.appendChild(el("h3", "", "Top titres"));
    var tList = el("ol", "hqm-rank");
    (recap.top_tracks || []).forEach(function (track) {
      var li = el("li", "");
      var line = el("div", "hqm-rank-line");
      line.appendChild(el("strong", "", track.name));
      if (track.uri) {
        line.appendChild(iconBtn("Lire " + track.name, "play", function () {
          playerAction("play", { uris: [track.uri] }).catch(function (e) { status(friendlyPlayerError(e), true); });
        }));
      }
      li.appendChild(line);
      li.appendChild(el("span", "hqm-muted", (track.artists || []).join(", ") + " · " + track.plays + "×"));
      tList.appendChild(li);
    });
    tracksCard.appendChild(tList);
    tops.appendChild(tracksCard);
    host.appendChild(tops);

    var heatCard = el("section", "hqm-card");
    heatCard.appendChild(el("h3", "", "Quand tu écoutes"));
    var heat = recap.heatmap || [];
    var max = 1;
    heat.forEach(function (row) { row.forEach(function (v) { max = Math.max(max, v); }); });
    var grid = el("div", "hqm-heat");
    grid.setAttribute("role", "img");
    grid.setAttribute("aria-label", "Carte des écoutes par jour de la semaine et par heure");
    grid.appendChild(el("span", "hqm-heat-corner"));
    for (var hour = 0; hour < 24; hour += 1) grid.appendChild(el("span", "hqm-heat-hour", hour % 6 === 0 ? String(hour) : ""));
    heat.forEach(function (row, day) {
      grid.appendChild(el("span", "hqm-heat-day", WEEKDAYS[day]));
      row.forEach(function (value, h) {
        var cell = el("span", "hqm-heat-cell");
        cell.style.setProperty("--a", value ? (0.18 + 0.82 * value / max).toFixed(2) : "0");
        cell.title = WEEKDAYS_LONG[day] + " " + h + " h : " + value + " écoute" + (value > 1 ? "s" : "");
        grid.appendChild(cell);
      });
    });
    heatCard.appendChild(grid);
    host.appendChild(heatCard);

    if ((recap.new_artists || []).length) {
      var fresh = el("section", "hqm-card");
      fresh.appendChild(el("h3", "", "Découverts ce mois-ci"));
      var chips = el("div", "hqm-preset-row");
      recap.new_artists.forEach(function (artist) {
        var chip = btn(artist.name + " · " + dayLabel(artist.first_heard), "hqm-chip", function () { openArtist({ name: artist.name }); });
        chips.appendChild(chip);
      });
      fresh.appendChild(chips);
      host.appendChild(fresh);
    }
  }

  /* Quiz Musica : blind test sur ta bibliothèque. */
  function ensureQuiz() {
    if (!state.quiz) state.quiz = { source: "saved", rounds: 5, playlistId: "", game: null, result: null, busy: false, revealed: false };
    return state.quiz;
  }

  async function quizNext() {
    var quiz = ensureQuiz();
    quiz.busy = true;
    quiz.result = null;
    quiz.revealed = false;
    render();
    try {
      var data = await call("/api/music/quiz/next", "POST", { id: quiz.game.id });
      quiz.game = Object.assign({}, quiz.game, data);
      setTimeout(function () { refreshPlayer(true).catch(function () {}); }, 1200);
    } catch (err) {
      status(friendlyPlayerError(err), true);
      var current = await call("/api/music/quiz").catch(function () { return null; });
      if (current && current.game) quiz.game = current.game;
    } finally {
      quiz.busy = false;
      render();
    }
  }

  function renderQuiz(host) {
    renderQuizCard(host);
    if (state.spotify && state.spotify.connected) renderTournamentSection(host);
  }

  function renderQuizCard(host) {
    var quiz = ensureQuiz();
    var card = el("section", "hqm-card hqm-quiz");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("h3", "", "Quiz Musica"));
    copy.appendChild(el("p", "hqm-muted",
      "Un extrait de ta bibliothèque démarre au hasard ; trouve le bon titre parmi quatre. Musica tient le score."));
    head.appendChild(copy);
    if (quiz.best) head.appendChild(el("span", "hqm-badge ok", "Record " + quiz.best));
    card.appendChild(head);
    var game = quiz.game;
    if (!game || game.done && !quiz.result) {
      var setup = el("div", "hqm-row hqm-quiz-setup");
      var source = document.createElement("select");
      source.setAttribute("aria-label", "Source du quiz");
      [["saved", "Titres aimés"], ["top", "Tes tops Spotify"], ["playlist", "Une playlist…"]].forEach(function (pair) {
        source.appendChild(new Option(pair[1], pair[0]));
      });
      source.value = quiz.source;
      source.addEventListener("change", function () { quiz.source = source.value; render(); });
      setup.appendChild(source);
      if (quiz.source === "playlist") {
        var pl = document.createElement("select");
        pl.setAttribute("aria-label", "Playlist du quiz");
        pl.appendChild(new Option("Choisir…", ""));
        (state.playlists || []).forEach(function (playlist) { pl.appendChild(new Option(playlist.name, playlist.id)); });
        pl.value = quiz.playlistId;
        pl.addEventListener("change", function () { quiz.playlistId = pl.value; });
        setup.appendChild(pl);
      }
      var rounds = document.createElement("select");
      rounds.setAttribute("aria-label", "Nombre de manches");
      rounds.appendChild(new Option("5 manches", "5"));
      rounds.appendChild(new Option("10 manches", "10"));
      rounds.value = String(quiz.rounds);
      rounds.addEventListener("change", function () { quiz.rounds = Number(rounds.value); });
      setup.appendChild(rounds);
      var startBtn = cardButton(setup, "Commencer", async function () {
        var data = await call("/api/music/quiz/start", "POST", {
          source: quiz.source, rounds: quiz.rounds, playlist_id: quiz.playlistId || undefined
        });
        quiz.game = data;
        quiz.best = data.best || quiz.best;
        await quizNext();
      });
      startBtn.classList.remove("secondary");
      card.appendChild(setup);
      host.appendChild(card);
      return;
    }
    var score = el("div", "hqm-quiz-score");
    score.appendChild(el("span", "", "Manche " + Math.max(1, game.round) + " / " + game.total));
    score.appendChild(el("strong", "", game.score + " pt" + (game.score > 1 ? "s" : "")));
    card.appendChild(score);
    if (quiz.busy) card.appendChild(el("p", "hqm-muted", "Musica lance l’extrait…"));
    if (quiz.result) {
      var reveal = el("div", "hqm-quiz-reveal " + (quiz.result.right ? "is-right" : "is-wrong"));
      if (quiz.result.correct && quiz.result.correct.image) {
        var cover = el("img", "hqm-thumb");
        cover.alt = "";
        applyCover(cover, quiz.result.correct.image, 64);
        reveal.appendChild(cover);
      }
      var meta = el("div", "hqm-track-meta");
      meta.appendChild(el("strong", "", quiz.result.correct ? quiz.result.correct.name : "?"));
      meta.appendChild(el("span", "", quiz.result.correct ? (quiz.result.correct.artists || []).join(", ") : ""));
      meta.appendChild(el("span", "hqm-reason", "Musica : " + quiz.result.line));
      reveal.appendChild(meta);
      card.appendChild(reveal);
      var next = el("div", "hqm-row");
      if (game.done) {
        cardButton(next, "Rejouer", function () {
          quiz.game = null; quiz.result = null; quiz.revealed = false;
          render();
          return Promise.resolve();
        }).classList.remove("secondary");
      } else {
        cardButton(next, "Manche suivante", quizNext).classList.remove("secondary");
      }
      card.appendChild(next);
    } else if (game.awaiting && !quiz.busy) {
      var choices = el("div", "hqm-quiz-choices");
      (game.choices || []).forEach(function (choice, index) {
        var option = btn("", "hqm-quiz-choice", async function () {
          choices.querySelectorAll("button").forEach(function (b) { b.disabled = true; });
          try {
            var data = await call("/api/music/quiz/answer", "POST", { id: game.id, choice: index });
            quiz.result = data;
            quiz.revealed = true;
            quiz.game = Object.assign({}, game, data);
            if (data.best) quiz.best = data.best;
            musicaReact(data.right ? "smile" : "surprise");
            // The verdict and the scripted line are on screen; her model-written reaction streams in and replaces it.
            if (data.reaction && data.reaction.pending) streamQuizReaction(data);
            else if (state.musicaSpeaks) speakMusica(data.line).catch(function () {});
          } catch (err) {
            status(err.message, true);
          }
          render();
        });
        option.appendChild(el("strong", "", choice.name));
        option.appendChild(el("span", "", (choice.artists || []).join(", ")));
        choices.appendChild(option);
      });
      card.appendChild(choices);
      var replay = el("div", "hqm-row");
      cardButton(replay, "Réentendre l’extrait", quizNext);
      card.appendChild(replay);
    }
    host.appendChild(card);
  }

  /* Swipe des découvertes : droite = j’aime, gauche = je n’aime pas, haut/bouton = pas maintenant. */
  async function openDeck() {
    state.deck = { open: true, loading: true, items: [], index: 0, liked: [] };
    render();
    try {
      var data = await call("/api/music/deck", "POST", { unknown_only: true });
      state.deck.items = (data.tracks || []).filter(function (t) { return t.uri; });
      state.deck.loading = false;
      render();
      deckPlay();
    } catch (err) {
      state.deck.loading = false;
      state.deck.error = err.message || "Découvertes indisponibles";
      render();
    }
  }

  function deckPlay() {
    var deck = state.deck;
    var item = deck && deck.items[deck.index];
    if (!item) return;
    playerAction("play", { uris: [item.uri] }).catch(function (e) { status(friendlyPlayerError(e), true); });
  }

  function deckDecide(kind) {
    var deck = state.deck;
    var item = deck && deck.items[deck.index];
    if (!item || deck.deciding) return;
    deck.deciding = true;
    var artist = (item.artists || [])[0] || "";
    var action = kind === "like" ? "like" : kind === "dislike" ? "dislike" : "dismiss";
    var request = call("/api/music/feedback", "POST", { title: item.name, artist: artist, uri: item.uri, action: action });
    if (kind === "skip") request = request.then(function () { return updateTaste({ seen: item.uri }); });
    request.catch(function (e) { status(e.message, true); });
    if (kind === "like") deck.liked.push(item);
    var top = state.host && state.host.querySelector(".hqm-swipe-card");
    if (top) top.classList.add(kind === "like" ? "is-out-right" : kind === "dislike" ? "is-out-left" : "is-out-up");
    setTimeout(function () {
      deck.deciding = false;
      deck.index += 1;
      render();
      deckPlay();
    }, top ? 220 : 0);
  }

  function renderDeck(host) {
    var deck = state.deck;
    var card = el("section", "hqm-card hqm-swipe");
    var head = el("div", "hqm-card-head");
    head.appendChild(el("h3", "", "Swipe découvertes"));
    head.appendChild(btn("Fermer", "hqm-btn secondary", function () { state.deck = null; render(); }));
    card.appendChild(head);
    if (deck.loading) {
      card.appendChild(el("p", "hqm-muted", "Musica rassemble des titres vérifiés sur Spotify…"));
      host.appendChild(card);
      return;
    }
    if (deck.error) {
      card.appendChild(el("p", "hqm-status is-error", deck.error));
      host.appendChild(card);
      return;
    }
    var item = deck.items[deck.index];
    if (!item) {
      card.appendChild(el("p", "", deck.liked.length
        ? deck.liked.length + " coup(s) de cœur — ils comptent dans tes goûts et le Mixer."
        : "Paquet terminé. Rien ne t’a accroché cette fois."));
      deck.liked.forEach(function (row) { card.appendChild(renderMusicCard(Object.assign({ kind: "track" }, row))); });
      var again = el("div", "hqm-row");
      cardButton(again, "Nouveau paquet", openDeck);
      card.appendChild(again);
      host.appendChild(card);
      return;
    }
    card.appendChild(el("p", "hqm-muted hqm-hint", (deck.index + 1) + " / " + deck.items.length +
      " · glisse à droite si tu aimes, à gauche sinon. Flèches du clavier aussi."));
    var stage = el("div", "hqm-swipe-stage");
    var swipe = el("article", "hqm-swipe-card");
    swipe.tabIndex = 0;
    swipe.setAttribute("aria-label", (item.name || "") + " — " + (item.artists || []).join(", "));
    if (item.image) {
      var cover = el("img", "hqm-swipe-cover");
      cover.alt = "";
      cover.draggable = false;
      applyCover(cover, item.image, 320, "(max-width: 700px) 80vw, 320px");
      swipe.appendChild(cover);
    } else {
      swipe.appendChild(el("div", "hqm-swipe-cover"));
    }
    var meta = el("div", "hqm-track-meta");
    meta.appendChild(el("strong", "", item.name || "?"));
    var artistBtn = btn((item.artists || []).join(", "), "hqm-link-btn", function () {
      openArtist({ name: (item.artists || [])[0] || "" });
    });
    meta.appendChild(artistBtn);
    if (item.why) meta.appendChild(el("span", "hqm-reason", item.why));
    swipe.appendChild(meta);
    var hintL = el("span", "hqm-swipe-stamp is-no", "Bof");
    var hintR = el("span", "hqm-swipe-stamp is-yes", "J’aime");
    swipe.append(hintL, hintR);
    var startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;
    swipe.addEventListener("pointerdown", function (event) {
      if (event.target.closest("button")) return;
      dragging = true; startX = event.clientX; startY = event.clientY; dx = dy = 0;
      swipe.setPointerCapture(event.pointerId);
      swipe.classList.add("is-dragging");
    });
    swipe.addEventListener("pointermove", function (event) {
      if (!dragging) return;
      dx = event.clientX - startX; dy = event.clientY - startY;
      swipe.style.transform = "translate(" + dx + "px," + Math.min(0, dy) + "px) rotate(" + dx / 18 + "deg)";
      swipe.style.setProperty("--yes", Math.max(0, Math.min(1, dx / 110)).toFixed(2));
      swipe.style.setProperty("--no", Math.max(0, Math.min(1, -dx / 110)).toFixed(2));
    });
    function release() {
      if (!dragging) return;
      dragging = false;
      swipe.classList.remove("is-dragging");
      if (dx > 100) deckDecide("like");
      else if (dx < -100) deckDecide("dislike");
      else if (dy < -110) deckDecide("skip");
      else { swipe.style.transform = ""; swipe.style.setProperty("--yes", "0"); swipe.style.setProperty("--no", "0"); }
    }
    swipe.addEventListener("pointerup", release);
    swipe.addEventListener("pointercancel", release);
    swipe.addEventListener("keydown", function (event) {
      if (event.key === "ArrowRight") { event.preventDefault(); deckDecide("like"); }
      if (event.key === "ArrowLeft") { event.preventDefault(); deckDecide("dislike"); }
      if (event.key === "ArrowUp") { event.preventDefault(); deckDecide("skip"); }
    });
    stage.appendChild(swipe);
    card.appendChild(stage);
    var actions = el("div", "hqm-swipe-actions");
    var no = iconBtn("Je n’aime pas", "close", function () { deckDecide("dislike"); }, "hqm-swipe-no");
    var skip = iconBtn("Pas maintenant", "next", function () { deckDecide("skip"); }, "hqm-swipe-skip");
    var yes = iconBtn("J’aime", "heart", function () { deckDecide("like"); }, "hqm-swipe-yes");
    var queue = iconBtn("Ajouter à la file", "plus", function () {
      playerAction("queue_add", { uri: item.uri }).then(function () { status("Ajouté à la file."); })
        .catch(function (e) { status(friendlyPlayerError(e), true); });
    }, "hqm-swipe-queue");
    actions.append(no, skip, queue, yes);
    card.appendChild(actions);
    host.appendChild(card);
    requestAnimationFrame(function () { if (swipe.isConnected && window.innerWidth > 700) swipe.focus({ preventScroll: true }); });
  }

  /* Page artiste : discographie en frise, badges Radar, tout jouer. */
  async function openArtist(ref) {
    if (!ref || !(ref.id || ref.name)) return;
    state.artistPage = { id: ref.id || null, name: ref.name || "", loading: true, albums: [], image: ref.image || null };
    render();
    var page = state.artistPage;
    try {
      if (!page.id) {
        var found = await call("/api/spotify/search?type=artist&limit=5&q=" +
          encodeURIComponent('artist:"' + page.name.replaceAll('"', " ") + '"'));
        var artists = found.artists || [];
        var match = artists.find(function (a) { return (a.name || "").toLowerCase() === page.name.toLowerCase(); }) || artists[0];
        if (!match) throw new Error("Artiste introuvable sur Spotify.");
        page.id = match.id;
        page.name = match.name || page.name;
        page.image = match.image || page.image;
        page.uri = match.uri;
      }
      page.uri = page.uri || "spotify:artist:" + page.id;
      var offset = 0, guard = 0;
      do {
        var data = await call("/api/spotify/artists/" + encodeURIComponent(page.id) + "/albums?offset=" + offset);
        page.albums = page.albums.concat(data.albums || []);
        offset = data.next_offset;
        guard += 1;
      } while (offset != null && guard < 8 && state.artistPage === page);
      var journal = await call("/api/music/journal-lookup/" + encodeURIComponent(page.name)).catch(function () { return null; });
      page.journal = journal && journal.artist;
    } catch (err) {
      page.error = err.message || "Page artiste indisponible";
    }
    page.loading = false;
    if (state.artistPage === page) render();
  }

  function renderArtistPage(host) {
    var page = state.artistPage;
    var sheet = el("div", "hqm-artist-sheet");
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-modal", "true");
    sheet.setAttribute("aria-label", "Artiste " + page.name);
    var backdrop = btn("", "hqm-artist-backdrop", function () { state.artistPage = null; render(); });
    backdrop.setAttribute("aria-label", "Fermer la page artiste");
    sheet.appendChild(backdrop);
    var panel = el("section", "hqm-card hqm-artist-panel");
    var head = el("div", "hqm-artist-head");
    if (page.image) {
      var img = el("img", "hqm-artist-photo");
      img.alt = "";
      applyCover(img, page.image, 96);
      head.appendChild(img);
    }
    var copy = el("div", "hqm-track-meta");
    copy.appendChild(el("h3", "", page.name || "Artiste"));
    var j = page.journal;
    copy.appendChild(el("span", "hqm-muted", j && j.count
      ? j.count + " écoute(s) dans ton journal · 1re le " + dayLabel(j.first) + " · dernière le " + dayLabel(j.last)
      : "Pas encore dans ton journal d’écoute."));
    head.appendChild(copy);
    var close = iconBtn("Fermer", "close", function () { state.artistPage = null; render(); }, "hqm-artist-close");
    head.appendChild(close);
    panel.appendChild(head);
    var actions = el("div", "hqm-row");
    if (page.uri) {
      cardButton(actions, "▶ Tout jouer", function () { return playerAction("play", { context_uri: page.uri }); })
        .classList.remove("secondary");
    }
    if (page.name) {
      cardButton(actions, "Demander à Musica", function () {
        state.artistPage = null;
        setTab("musica");
        return sendMusica("Parle-moi de " + page.name + " et propose-moi par où commencer sa discographie.");
      });
    }
    panel.appendChild(actions);
    if (page.loading) panel.appendChild(skeletonDetail());
    else if (page.error) panel.appendChild(el("p", "hqm-status is-error", page.error));
    else {
      var radarUris = new Set(((state.radar && state.radar.items) || []).map(function (a) { return a.uri; }));
      var byYear = new Map();
      page.albums.slice().sort(function (a, b) { return String(b.release_date || "").localeCompare(String(a.release_date || "")); })
        .forEach(function (album) {
          var year = album.year || "?";
          if (!byYear.has(year)) byYear.set(year, []);
          byYear.get(year).push(album);
        });
      var timeline = el("ol", "hqm-timeline");
      byYear.forEach(function (albums, year) {
        var li = el("li", "");
        li.appendChild(el("span", "hqm-timeline-year", year));
        var row = el("div", "hqm-timeline-row");
        albums.forEach(function (album) {
          var item = el("article", "hqm-timeline-item" + (radarUris.has(album.uri) ? " is-new" : ""));
          if (album.image) {
            var cover = el("img", "hqm-thumb");
            cover.alt = "";
            cover.loading = "lazy";
            applyCover(cover, album.image, 56);
            item.appendChild(cover);
          }
          var meta = el("div", "hqm-track-meta");
          meta.appendChild(el("strong", "", album.name || "?"));
          meta.appendChild(el("span", "hqm-muted", (album.album_type === "single" ? "Single" : "Album") +
            (album.total_tracks ? " · " + album.total_tracks + " titres" : "")));
          if (radarUris.has(album.uri)) meta.appendChild(el("span", "hqm-badge ok", "Radar · nouveau"));
          item.appendChild(meta);
          if (album.uri) {
            item.appendChild(iconBtn("Lire " + (album.name || "l’album"), "play", function () {
              playerAction("play", { context_uri: album.uri }).catch(function (e) { status(friendlyPlayerError(e), true); });
            }));
          }
          row.appendChild(item);
        });
        li.appendChild(row);
        timeline.appendChild(li);
      });
      if (!page.albums.length) panel.appendChild(el("p", "hqm-muted", "Aucun album ou single renvoyé par Spotify."));
      panel.appendChild(timeline);
    }
    sheet.appendChild(panel);
    sheet.addEventListener("keydown", function (event) {
      if (event.key === "Escape") { state.artistPage = null; render(); }
    });
    host.appendChild(sheet);
    requestAnimationFrame(function () { if (close.isConnected) close.focus({ preventScroll: true }); });
  }

  /* Humeur du jour, tirée du calendrier (lecture seule, aucun appel au modèle). */
  async function loadMood() {
    try {
      var data = await call("/api/music/mood");
      state.mood = data.mood;
    } catch (_e) {
      state.mood = null;
    }
    return state.mood;
  }

  function renderMood(host) {
    var mood = state.mood;
    if (!mood) return;
    var card = el("section", "hqm-card hqm-mood");
    var head = el("div", "hqm-card-head");
    var copy = el("div", "");
    copy.appendChild(el("span", "hqm-eyebrow", "Suggestion du jour · d’après ton calendrier"));
    copy.appendChild(el("h3", "", mood.label));
    var details = mood.reason + (mood.next_event ? " Prochain : « " + mood.next_event.title + " » à " + mood.next_event.start + "." : "");
    copy.appendChild(el("p", "hqm-muted", details));
    head.appendChild(copy);
    card.appendChild(head);
    var actions = el("div", "hqm-row");
    async function launch(play) {
      var data = await call("/api/music/activity", "POST", { activity: mood.activity, minutes: mood.minutes, play: play });
      state.session = data;
      status(play ? (data.playing ? "Session lancée." : "Session prête — lecture impossible : " + (data.playback_code || "appareil")) :
        "Session prête dans l’aperçu.");
      if (state.tab === "mixer") render();
    }
    cardButton(actions, "▶ Lancer", function () { return launch(true); }).classList.remove("secondary");
    cardButton(actions, "Préparer seulement", function () { return launch(false); });
    card.appendChild(actions);
    host.appendChild(card);
  }

  /* Studio : variantes, paroles co-écrites, remix (passage, style, prolongation), bibliothèque. */
  var waveCache = new Map();

  async function wavePeaks(url) {
    if (waveCache.has(url)) return waveCache.get(url);
    var Ctx = root.AudioContext || root.webkitAudioContext;
    if (!Ctx) throw new Error("Analyse audio indisponible dans ce navigateur.");
    var buffer = await fetch(url, { credentials: "same-origin" }).then(function (r) {
      if (!r.ok) throw new Error("Audio indisponible");
      return r.arrayBuffer();
    });
    var ctx = new Ctx();
    try {
      var audio = await ctx.decodeAudioData(buffer);
      var data = audio.getChannelData(0);
      var buckets = 240, size = Math.floor(data.length / buckets) || 1, peaks = [];
      for (var i = 0; i < buckets; i += 1) {
        var peak = 0;
        for (var j = i * size; j < Math.min(data.length, (i + 1) * size); j += 16) peak = Math.max(peak, Math.abs(data[j]));
        peaks.push(peak);
      }
      var result = { peaks: peaks, duration: audio.duration };
      waveCache.set(url, result);
      return result;
    } finally {
      if (ctx.close) ctx.close();
    }
  }

  function drawWave(canvas, wave, sel) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 300, h = canvas.clientHeight || 72;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    var styles = getComputedStyle(canvas);
    var accent = styles.getPropertyValue("--accent").trim() || "#7c9cff";
    var muted = styles.color || "#9aa3b2";
    ctx.clearRect(0, 0, w, h);
    if (sel && wave.duration) {
      var x0 = sel.start / wave.duration * w, x1 = sel.end / wave.duration * w;
      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.18;
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.globalAlpha = 1;
    }
    var max = Math.max.apply(null, wave.peaks.concat([0.01]));
    var barW = w / wave.peaks.length;
    wave.peaks.forEach(function (peak, i) {
      var x = i * barW, t = (i + 0.5) / wave.peaks.length * wave.duration;
      var inSel = sel && t >= sel.start && t <= sel.end;
      var bh = Math.max(1.5, peak / max * (h - 6));
      ctx.fillStyle = inSel ? accent : muted;
      ctx.globalAlpha = inSel ? 1 : 0.55;
      ctx.fillRect(x + barW * 0.15, (h - bh) / 2, Math.max(1, barW * 0.7), bh);
    });
    ctx.globalAlpha = 1;
  }

  function fmtSec(sec) {
    sec = Math.max(0, Math.round(sec));
    return Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
  }

  function renderRemixPanel(job, card) {
    var panel = el("details", "hqm-advanced hqm-remix");
    var summary = document.createElement("summary");
    summary.textContent = "Remixer";
    panel.appendChild(summary);
    var body = el("div", "hqm-advanced-body");
    panel.appendChild(body);
    var built = false;
    panel.addEventListener("toggle", function () {
      if (!panel.open || built) return;
      built = true;
      var duration = Number(job.duration_seconds || job.duration) || 90;
      var mode = { task: "repaint", sel: { start: Math.max(0, duration * 0.4), end: Math.min(duration, duration * 0.4 + 12) } };
      var modes = el("div", "hqm-seg");
      modes.setAttribute("role", "tablist");
      var forms = {};
      [["repaint", "Refaire un passage"], ["cover", "Changer de style"], ["extend", "Prolonger"]].forEach(function (pair) {
        var b = btn(pair[1], "hqm-seg-btn", function () {
          mode.task = pair[0];
          modes.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
          Object.keys(forms).forEach(function (key) { forms[key].hidden = key !== mode.task; });
        });
        b.setAttribute("role", "tab");
        b.setAttribute("aria-selected", String(pair[0] === mode.task));
        modes.appendChild(b);
      });
      body.appendChild(modes);

      var prompt = document.createElement("textarea");
      prompt.rows = 2;
      prompt.maxLength = 512;
      prompt.value = job.prompt || "";
      prompt.setAttribute("aria-label", "Style pour le remix");
      var promptLabel = el("label", "", "Style (modifiable)");
      promptLabel.appendChild(prompt);

      var repaint = el("div", "hqm-remix-form");
      var canvas = el("canvas", "hqm-wave");
      canvas.setAttribute("aria-label", "Forme d’onde — glisse pour choisir le passage");
      var range = el("p", "hqm-muted hqm-hint", "");
      function paintRange() { range.textContent = "Passage : " + fmtSec(mode.sel.start) + " → " + fmtSec(mode.sel.end) + " (glisse sur la forme d’onde)"; }
      paintRange();
      repaint.append(canvas, range);
      var wave = null;
      wavePeaks(job.audio_url).then(function (w) {
        wave = w;
        duration = w.duration || duration;
        drawWave(canvas, wave, mode.sel);
      }).catch(function (err) { range.textContent = err.message + " — passage par défaut " + fmtSec(mode.sel.start) + " → " + fmtSec(mode.sel.end); });
      var anchor = null;
      function timeAt(event) {
        var rect = canvas.getBoundingClientRect();
        return Math.max(0, Math.min(duration, (event.clientX - rect.left) / rect.width * duration));
      }
      canvas.addEventListener("pointerdown", function (event) {
        anchor = timeAt(event);
        canvas.setPointerCapture(event.pointerId);
      });
      canvas.addEventListener("pointermove", function (event) {
        if (anchor == null) return;
        var t = timeAt(event);
        mode.sel = { start: Math.min(anchor, t), end: Math.max(anchor, t) };
        paintRange();
        if (wave) drawWave(canvas, wave, mode.sel);
      });
      canvas.addEventListener("pointerup", function () {
        anchor = null;
        if (mode.sel.end - mode.sel.start < 2) mode.sel.end = Math.min(duration, mode.sel.start + 2);
        if (mode.sel.end - mode.sel.start < 2) mode.sel.start = Math.max(0, mode.sel.end - 2);
        paintRange();
        if (wave) drawWave(canvas, wave, mode.sel);
      });
      forms.repaint = repaint;

      var cover = el("div", "hqm-remix-form");
      cover.hidden = true;
      var strengthLabel = el("label", "", "Fidélité à l’original");
      var strength = document.createElement("input");
      strength.type = "range"; strength.min = "0.1"; strength.max = "1"; strength.step = "0.05"; strength.value = "0.5";
      var strengthOut = el("output", "hqm-range-value", "50 %");
      strength.addEventListener("input", function () { strengthOut.textContent = Math.round(Number(strength.value) * 100) + " %"; });
      strengthLabel.append(strength, strengthOut);
      cover.appendChild(strengthLabel);
      cover.appendChild(el("p", "hqm-muted hqm-hint", "Bas = réinterprétation libre dans le nouveau style ; haut = structure et mélodie gardées."));
      forms.cover = cover;

      var extend = el("div", "hqm-remix-form");
      extend.hidden = true;
      var extraLabel = el("label", "", "Secondes à ajouter");
      var extra = document.createElement("select");
      [10, 20, 30, 45, 60].forEach(function (n) { extra.appendChild(new Option("+" + n + " s", String(n))); });
      extra.value = "30";
      extraLabel.appendChild(extra);
      extend.appendChild(extraLabel);
      extend.appendChild(el("p", "hqm-muted hqm-hint", "ACE-Step continue le morceau après sa fin (durée finale ≤ 180 s)."));
      forms.extend = extend;

      body.append(repaint, cover, extend, promptLabel);
      var go = el("div", "hqm-row");
      var launch = cardButton(go, "Lancer le remix", async function () {
        var payload = { task: mode.task, source_id: job.id, prompt: prompt.value, lyrics: job.lyrics || "",
          seed: Math.floor(Math.random() * 2147483647), language: job.language || "en",
          duration: 90, bpm: job.bpm || null, title: job.title || (job.gift && job.gift.title) || undefined };
        if (mode.task === "repaint") { payload.start = Math.round(mode.sel.start * 100) / 100; payload.end = Math.round(mode.sel.end * 100) / 100; }
        if (mode.task === "cover") payload.strength = Number(strength.value);
        if (mode.task === "extend") payload.extra = Number(extra.value);
        await call("/api/music/studio/generate", "POST", payload);
        status("Remix lancé — la nouvelle version apparaîtra en haut des créations.");
        panel.open = false;
        await refreshStudio();
      });
      launch.classList.remove("secondary");
      body.appendChild(go);
    });
    card.appendChild(panel);
  }

  function renderStudioJob(job) {
    var card = el("div", "hqm-card hqm-studio-job");
    var task = { repaint: "Passage refait", cover: "Nouveau style", extend: "Prolongé" }[job.task];
    var title = (job.gift ? "🎁 " + job.gift.title + " · " : job.title ? job.title + " · " : "") +
      (task ? task + " · " : "") + "Seed " + job.seed + " · " + Math.round(job.duration_seconds || job.duration) + " s";
    card.appendChild(el("strong", "", title));
    if (job.gift && job.gift.note) card.appendChild(el("p", "", "Musica : " + job.gift.note));
    card.appendChild(el("p", "hqm-muted", job.prompt));
    if (job.lyrics && (job.gift || job.lyrics.length > 0)) {
      var details = document.createElement("details"), summary = document.createElement("summary");
      summary.textContent = "Voir les paroles"; details.appendChild(summary);
      details.appendChild(el("pre", "hqm-gift-lyrics", job.lyrics));
      card.appendChild(details);
    }
    if (job.status === "completed" && (job.variant_urls || []).length > 1) {
      card.appendChild(el("p", "hqm-muted", "Écoute les variantes et garde ta préférée (les autres vont dans la corbeille du Studio)."));
      var variants = el("div", "hqm-variants");
      job.variant_urls.forEach(function (url, index) {
        var letter = String.fromCharCode(65 + index);
        var box = el("div", "hqm-variant");
        box.appendChild(el("strong", "", "Version " + letter));
        var audio = document.createElement("audio");
        audio.controls = true; audio.preload = "none"; audio.src = url;
        audio.addEventListener("play", function () {
          variants.querySelectorAll("audio").forEach(function (other) { if (other !== audio) other.pause(); });
        });
        box.appendChild(audio);
        if (root.hqMusicaBindLyricAudio) root.hqMusicaBindLyricAudio(audio, job.title);
        var keep = el("div", "hqm-row");
        cardButton(keep, "Garder " + letter, async function () {
          await call("/api/music/studio/pick", "POST", { id: job.id, variant: index + 1 });
          status("Version " + letter + " gardée.");
          await refreshStudio();
        }).classList.remove("secondary");
        box.appendChild(keep);
        variants.appendChild(box);
      });
      card.appendChild(variants);
    } else if (job.status === "completed") {
      var audio = document.createElement("audio");
      audio.controls = true; audio.preload = "none"; audio.src = job.audio_url;
      card.appendChild(audio);
      if (root.hqMusicaBindLyricAudio) root.hqMusicaBindLyricAudio(audio, job.title);
      var row = el("div", "hqm-row");
      var download = el("a", "hqm-btn secondary", "Télécharger MP3");
      download.href = job.audio_url;
      download.download = "transfert-hq-" + job.seed + ".mp3";
      row.appendChild(download);
      cardButton(row, "Envoyer à l’iPhone / Lecteur", async function () {
        var data = await call("/api/music/studio/library", "POST", { id: job.id, notify: true });
        status("Copié dans " + data.rel + (data.notified ? " — notification envoyée." : " — visible dans Lecteur et Fichiers."));
      });
      card.appendChild(row);
      renderRemixPanel(job, card);
    } else if (job.status === "failed") {
      card.appendChild(el("p", "hqm-status is-error", job.error || "Génération échouée"));
    } else {
      card.appendChild(el("p", "hqm-muted", "Génération en cours" + (job.variants > 1 ? " (" + job.variants + " variantes)" : "") + "…"));
    }
    if (job.status === "completed" || job.status === "failed") {
      var remove = btn("Supprimer", "hqm-btn secondary", async function () {
        if (!window.confirm("Déplacer cette création dans la corbeille locale du Studio ?")) return;
        remove.disabled = true;
        try {
          await call("/api/music/studio/delete", "POST", { id: job.id });
          status("Création déplacée dans la corbeille locale.");
          await refreshStudio();
        } catch (err) { status(err.message, true); remove.disabled = false; }
      });
      card.appendChild(remove);
    }
    return card;
  }

  function renderLyricsHelper(form, prompt, lyrics, lang, duration) {
    var box = el("div", "hqm-lyrics-help");
    var idea = document.createElement("input");
    idea.type = "text";
    idea.maxLength = 600;
    idea.placeholder = "Idée ou thème pour Musica (facultatif)";
    idea.setAttribute("aria-label", "Idée pour les paroles");
    idea.value = state.studioIdea || "";
    idea.addEventListener("input", function () { state.studioIdea = idea.value; });
    box.appendChild(idea);
    var row = el("div", "hqm-row");
    var note = el("p", "hqm-muted hqm-hint", "");
    note.hidden = true;
    function ask(mode) {
      return async function () {
        var data = await call("/api/music/studio/lyrics", "POST", {
          mode: mode, prompt: prompt.value, idea: idea.value, lyrics: lyrics.value,
          language: lang.value === "fr" ? "fr" : "en", duration: Number(duration.value) || 90
        });
        lyrics.value = data.lyrics;
        state.studioDraft.lyrics = data.lyrics;
        note.textContent = data.note ? "Musica : " + data.note : "";
        note.hidden = !data.note;
      };
    }
    cardButton(row, "✍ Musica écrit", ask("draft"));
    cardButton(row, "Musica retouche", ask("refine"));
    box.append(row, note);
    form.insertBefore(box, lyrics.parentNode.nextSibling);
  }

  function curveTarget(curve, x) {
    if (curve === "arc") return x <= 0.65 ? 1.5 + 3.5 * (x / 0.65) : 5 - 3 * (x - 0.65) / 0.35;
    if (curve === "rise") return 1.5 + 3.5 * x;
    if (curve === "fall") return 5 - 3.5 * x;
    if (curve === "waves") return 3 + 1.8 * Math.sin(2 * Math.PI * 2 * x);
    return 3;
  }

  function drawCurve(canvas, curve) {
    var dpr = window.devicePixelRatio || 1;
    var w = canvas.clientWidth || 240, h = canvas.clientHeight || 40;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    canvas.hidden = curve === "none";
    if (curve === "none") return;
    ctx.strokeStyle = getComputedStyle(canvas).getPropertyValue("--accent").trim() || "#7c9cff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (var i = 0; i <= 60; i += 1) {
      var x = i / 60, y = h - 4 - (curveTarget(curve, x) - 1) / 4 * (h - 8);
      if (i) ctx.lineTo(x * w, y); else ctx.moveTo(0, y);
    }
    ctx.stroke();
  }

  /* ---- Always-there helpers: playback recovery, last-known state, request line, « on air » strip, mood dial --------- */

  var LAST_KEY = "hqm_last_playback";

  function saveLastKnown(player) {
    var item = player && player.item;
    if (!item || !item.uri) return;
    if (state.lastSavedUri === item.uri) return;  // once per track: nothing to write on every poll
    state.lastSavedUri = item.uri;
    try {
      localStorage.setItem(LAST_KEY, JSON.stringify({ at: Date.now(), item: {
        uri: item.uri, name: item.name, artists: item.artists, album: item.album, image: item.image, duration_ms: item.duration_ms } }));
    } catch (_e) {}
  }

  function loadLastKnown() {
    try {
      var raw = JSON.parse(localStorage.getItem(LAST_KEY) || "null");
      return raw && raw.item && raw.item.name ? raw : null;
    } catch (_e) { return null; }
  }

  /* Spotify unreachable: keep something on screen (the last known track, greyed) instead of a blank player. */
  function useLastKnownWhenOffline() {
    state.offline = true;
    if (state.player && state.player.item) return;
    var last = loadLastKnown();
    if (last) state.player = { playing: false, progress_ms: 0, item: last.item, offline: true, offline_at: last.at };
  }

  function noDeviceReason() {
    var local = state.localSpotify || (state.spotify && state.spotify.local) || null;
    if (local && local.spotify_desktop_running === false) return "Spotify Desktop est fermé sur ce PC, donc aucun appareil n’est disponible.";
    return "Spotify est ouvert mais aucun appareil n’est actif (rien n’a été lu récemment ou l’appareil s’est endormi).";
  }

  /* One button: wake Spotify Desktop if needed, find the best Connect device, transfer playback to it. */
  async function recoverDevice() {
    state.recovering = true;
    state.recoverNote = "";
    render();
    try {
      var wake = await call("/api/spotify/devices/wake", "POST", {});
      var devices = wake.devices || [];
      var target = devices.filter(function (d) { return d.is_local_candidate; })[0] ||
        devices.filter(function (d) { return d.is_active; })[0] || devices[0];
      if (!target) {
        state.recoverNote = ((wake.wake && wake.wake.message) || "Spotify n’a pas encore enregistré d’appareil") +
          " — patiente quelques secondes puis réessaie, ou ouvre Spotify sur un autre appareil.";
      } else {
        await playerAction("transfer", { device_id: target.id, play: false });
        state.preferredDeviceId = target.id;
        state.noDevice = false;
        state.playerError = null;
        state.recoverNote = "Lecture transférée sur « " + (target.name || "cet appareil") + " ».";
      }
    } catch (err) {
      state.recoverNote = friendlyPlayerError(err);
    } finally {
      state.recovering = false;
      render();
      refreshPlayer(true).catch(function () {});
    }
  }

  function renderPlaybackBanner() {
    if (!state.spotify || !state.spotify.connected) return null;
    var problem = state.noDevice || (state.playerError && state.playerError.code === "spotify_no_device");
    if (!problem && !state.offline) return null;
    var box = el("div", "hqm-banner hqm-dev-banner" + (problem ? " is-warn" : ""));
    box.setAttribute("role", "alert");
    var words = el("div", "hqm-dev-words");
    if (problem) {
      words.appendChild(el("strong", "", "Aucun appareil Spotify actif"));
      words.appendChild(el("span", "", state.recoverNote || noDeviceReason()));
    } else {
      words.appendChild(el("strong", "", "Spotify est injoignable"));
      words.appendChild(el("span", "", "Je garde le dernier titre connu en attendant que la connexion revienne."));
    }
    box.appendChild(words);
    var action = btn(state.recovering ? "…" : problem ? "Réveiller Spotify et transférer" : "Réessayer", "hqm-btn", function () {
      if (problem) recoverDevice();
      else { state.offline = false; refreshPlayer(false).catch(function () {}); }
    });
    action.disabled = !!state.recovering;
    box.appendChild(action);
    return box;
  }

  /* Request line: ask the DJ for something from any tab. */
  async function djRequest(text) {
    unlockAudio();
    state.prepDisplay = 2;
    state.requestText = "";
    status("Musica prépare ta demande…");
    return djAsk(text);
  }

  /* Talk back: « DJ, pourquoi cette chanson ? » is answered (text at once, voice as soon as it is recorded); a request
     steers the show as before, and an acknowledgement is said right away while the new segment is prepared. */
  async function djAsk(text) {
    unlockAudio();
    var data = await call("/api/musica/dj/ask", "POST", { text: text, device_id: state.preferredDeviceId || undefined });
    if (data.kind === "ask") {
      status("");
      musicaSay(data.text);
      state.djLast = { text: data.text, at: Date.now() };
      paintDjLine();
      announce("Musica répond : " + data.text);
      pollAskVoice(data.id, data.text);
      return data;
    }
    state.prepDisplay = 2;
    state.djShow = data;
    paintDjCard();
    watchPrep();
    if (data.ack) {
      musicaSay(data.ack.text);
      if (data.ack.drop) playDrops([data.ack.drop], data.ack.text, false).catch(function () {});  // no voice yet: the chip alone says it
    }
    return data;
  }

  function pollAskVoice(id, text) {
    var tries = 0;
    (function poll() {
      tries += 1;
      call("/api/musica/dj/ask/" + encodeURIComponent(id)).then(function (r) {
        if (r && r.pending && tries < 30) { setTimeout(poll, 700); return; }
        if (r && r.drop) playDrops([r.drop], text, false).catch(function () {});
        else speakMusica(text).catch(function () {});  // no expressive drop: the plain voice still answers
      }).catch(function () { if (tries < 3) setTimeout(poll, 900); });
    })();
  }

  function renderRequestBar() {
    if (!state.spotify || !state.spotify.connected) return null;
    var form = el("form", "hqm-request");
    form.setAttribute("role", "search");
    form.setAttribute("aria-label", "Demande au DJ");
    form.appendChild(el("span", "hqm-request-icon", "🎙"));
    var input = document.createElement("input");
    input.type = "text";
    input.maxLength = 300;
    input.placeholder = "Demande au DJ : « du métal des années 2000 », « pourquoi cette chanson ? »…";
    input.setAttribute("aria-label", "Demande au DJ");
    input.value = state.requestText || "";
    input.addEventListener("input", function () { state.requestText = input.value; });
    form.appendChild(input);
    var go = btn("Demander", "hqm-btn hqm-request-go");
    go.type = "submit";
    form.appendChild(go);
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      go.disabled = true;
      djRequest(text).catch(function (e) { status(e.message, true); }).then(function () { go.disabled = false; });
    });
    return form;
  }

  /* Mood dial: calm to hype, with an optional time budget; she lands softly when the time is up. */
  async function setMood(change) {
    try {
      state.djShow = await call("/api/musica/dj/mood", "POST", change);
      paintDjCard();
    } catch (err) { status(err.message, true); }
  }

  function renderMoodDial(show) {
    var mood = show.mood || {};
    var box = el("div", "hqm-mood");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", "Ambiance de l’émission");
    box.appendChild(el("span", "hqm-dj-label", "Ambiance"));
    var dial = el("div", "hqm-mood-dial");
    var names = ["Très calme", "Doux", "Équilibré", "Énergique", "À fond"];
    for (var level = 1; level <= 5; level += 1) {
      (function (n) {
        var b = btn(String(n), "hqm-mood-step" + (mood.energy === n ? " is-on" : ""), function () { setMood({ energy: n }); });
        b.setAttribute("aria-pressed", mood.energy === n ? "true" : "false");
        b.setAttribute("aria-label", names[n - 1] + " (" + n + " sur 5)");
        b.title = names[n - 1];
        dial.appendChild(b);
      })(level);
    }
    box.appendChild(dial);
    var minutes = document.createElement("select");
    minutes.setAttribute("aria-label", "Durée de l’émission");
    minutes.appendChild(new Option("Sans limite", ""));
    [15, 30, 45, 60, 90, 120].forEach(function (m) { minutes.appendChild(new Option(m + " min", String(m))); });
    minutes.value = mood.minutes && [15, 30, 45, 60, 90, 120].indexOf(mood.minutes) >= 0 ? String(mood.minutes) : "";
    minutes.addEventListener("change", function () {
      if (minutes.value) setMood({ minutes: Number(minutes.value) });
      else setMood({ clear: true });
    });
    box.appendChild(minutes);
    if (mood.remaining_min != null) {
      var left = Math.max(0, Math.round(mood.remaining_min));
      box.appendChild(el("span", "hqm-mood-left" + (mood.closing ? " is-closing" : ""),
        mood.closing ? "Dernier segment : atterrissage en douceur" : "Il reste " + left + " min"));
    }
    if (mood.energy || mood.minutes) {
      box.appendChild(btn("Effacer", "hqm-btn secondary hqm-mood-clear", function () { setMood({ clear: true }); }));
    }
    return box;
  }

  /* The « on air » strip: visible on every tab while the show runs, with the one-tap controls. */
  function renderOnAirStrip() {
    var show = state.djShow;
    var slot = el("section", "hqm-onair");
    slot.setAttribute("data-hqm", "onair-strip");
    if (!state.spotify || !state.spotify.connected || !show || !show.active || (show.prep && show.prep.running)) {
      slot.hidden = true;
      return slot;
    }
    slot.setAttribute("role", "region");
    slot.setAttribute("aria-label", "DJ Musica à l’antenne");
    var live = el("div", "hqm-onair-live");
    live.appendChild(el("span", "hqm-onair-dot"));
    live.appendChild(el("strong", "", "On air"));
    var seg = show.segment || {};
    var words = el("div", "hqm-onair-words");
    words.appendChild(el("span", "hqm-onair-title", (seg.title || "DJ Musica") + (seg.theme ? " · " + seg.theme : "")));
    var item = state.player && state.player.item;
    var upcoming = show.next && show.next.title ? "Ensuite : " + show.next.title : "Le prochain segment se prépare";
    words.appendChild(el("span", "hqm-muted", (item && !(show.duels && show.duels.current && show.duels.current.blind && !show.duels.current.vote)
      ? item.name + " · " : "") + upcoming));
    live.appendChild(words);
    slot.appendChild(live);
    var controls = el("div", "hqm-onair-controls");
    controls.appendChild(btn("⏭ Titre", "hqm-btn secondary", function () { playerAction("next").catch(function (e) { status(friendlyPlayerError(e), true); }); }));
    var nextSeg = btn("⏭ Segment", "hqm-btn secondary", async function () {
      unlockAudio();
      try {
        var data = await call("/api/musica/dj/next", "POST", {});
        state.djShow = data;
        if (data.awaiting) introThenGo(data.awaiting, data);
        else if (data.jump === "pending") watchAwaiting();
        paintStrip();
      } catch (err) { status(friendlyPlayerError(err), true); }
    });
    controls.appendChild(nextSeg);
    controls.appendChild(btn("■ Antenne", "hqm-btn secondary", async function () {
      state.djShow = await call("/api/musica/dj/stop", "POST", {});
      status("DJ Musica hors antenne.");
      paintDjCard();
      paintStrip();
    }));
    slot.appendChild(controls);
    var ambiance = el("details", "hqm-onair-mood");
    var summary = document.createElement("summary");
    summary.textContent = "Ambiance" + (show.mood && show.mood.energy ? " · " + show.mood.energy + "/5" : "") +
      (show.mood && show.mood.remaining_min != null ? " · " + Math.max(0, Math.round(show.mood.remaining_min)) + " min" : "");
    ambiance.appendChild(summary);
    ambiance.appendChild(renderMoodDial(show));
    slot.appendChild(ambiance);
    return slot;
  }

  function paintStrip() {
    if (!state.host) return;
    var slot = state.host.querySelector("[data-hqm='onair-strip']");
    if (!slot) return;
    var open = slot.querySelector("details[open]") !== null;
    var fresh = renderOnAirStrip();
    var details = fresh.querySelector("details");
    if (open && details) details.open = true;
    slot.replaceWith(fresh);
  }

  function render() {
    if (!state.host || !state.shown) return;
    var host = state.host;
    var snapshot = captureUiState();
    var sameTab = state.renderedTab === state.tab;
    var previousDock = host.querySelector(".hqm-dock");
    host.replaceChildren();

    var header = el("header", "hqm-header");
    var copy = el("div", "hqm-header-text");
    copy.appendChild(el("span", "hqm-eyebrow", "Transfert HQ · Salon musical"));
    copy.appendChild(el("h2", "", "Musique"));
    copy.appendChild(el("p", "", "Tes playlists, tes découvertes et ta musique, au même endroit."));
    header.appendChild(copy);
    header.appendChild(renderAccountChip());
    host.appendChild(header);

    var topbar = el("div", "hqm-topbar");
    var mobileHead = el("div", "hqm-mobile-head");
    mobileHead.appendChild(el("h2", "", "Musique"));
    mobileHead.appendChild(renderAccountChip());
    topbar.appendChild(mobileHead);
    topbar.appendChild(renderTabs());
    if (state.spotify && state.spotify.connected) topbar.appendChild(previousDock || renderDock());
    host.appendChild(topbar);

    var message = el("p", "hqm-status", "");
    message.setAttribute("role", "status");
    host.appendChild(message);
    var announcer = el("div", "hqm-sr-only", state.announcement || "");
    announcer.setAttribute("aria-live", "polite");
    announcer.setAttribute("aria-atomic", "true");
    announcer.setAttribute("data-hqm", "announcer");
    host.appendChild(announcer);
    var playbackBanner = renderPlaybackBanner();
    if (playbackBanner) host.appendChild(playbackBanner);
    host.appendChild(renderOnAirStrip());
    var requestBar = renderRequestBar();
    if (requestBar) host.appendChild(requestBar);

    var panel = el("div", "hqm-panel is-active");
    if (!sameTab) panel.classList.add("is-entering");
    panel.id = "hqm-panel-" + state.tab;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", "hqm-tab-" + state.tab);
    if (state.tab === "lecture") {
      panel.classList.add("hqm-lecture-dashboard");
      renderLecture(panel);
    } else if (state.tab === "playlists") renderPlaylists(panel);
    else if (state.tab === "mixer") renderMixer(panel);
    else if (state.tab === "musica") renderMusica(panel);
    else if (state.tab === "studio") renderStudio(panel);
    else if (state.tab === "journal") { renderWeeklyRecap(panel); renderWrapped(panel); renderOnThisDay(panel); renderTasteMap(panel); renderJournal(panel); }
    else if (state.tab === "quiz") renderQuiz(panel);
    else renderDiscoveries(panel);
    host.appendChild(panel);
    if (state.artistPage) renderArtistPage(host);
    var topbarNode = host.querySelector(".hqm-topbar");
    if (topbarNode) host.style.setProperty("--hqm-topbar-h", topbarNode.offsetHeight + "px");
    updateNowPlayingDom();
    restoreUiState(snapshot);
    if (state.tab === "musica" && state.musicaScrollBottom) {
      var log = host.querySelector(".hqm-chat-log");
      if (log) log.scrollTop = log.scrollHeight;
    }
    if (sameTab && !(state.tab === "musica" && isChatPaneWidth())) {
      window.scrollTo(0, snapshot.y);
    } else if (!sameTab && state.pendingTabScroll != null) {
      window.scrollTo(0, state.pendingTabScroll);
      state.pendingTabScroll = null;
    }
    state.renderedTab = state.tab;
  }

  /* mount(), show() and the view handler can each ask for a bootstrap in the same tick: share the one in flight. */
  var bootstrapRun = null;
  function bootstrap() {
    if (!bootstrapRun) {
      bootstrapRun = bootstrapOnce().then(function (v) { bootstrapRun = null; return v; }, function (e) { bootstrapRun = null; throw e; });
    }
    return bootstrapRun;
  }

  async function bootstrapOnce() {
    status("Chargement…");
    loadPrefs();
    try {
      await Promise.all([refreshStatus(), loadTaste()]);
      if (state.spotify && state.spotify.connected) {
        await Promise.all([
          refreshPlayer(true).catch(function () {}),
          loadDevices().catch(function () {}),
          loadPlaylists(true).catch(function () {})
        ]);
        if (!state.preferredDeviceId) {
          var active = (state.devices || []).find(function (d) { return d.is_active && !d.is_restricted; });
          if (active) savePreferredDevice(active.id);
        }
      }
      render();
      if (state.tab === "studio") {
        stopStudioPoll();
        refreshStudio();
        state.studioTimer = setInterval(refreshStudio, 5000);
      }
      if (state.spotify && state.spotify.connected) {
        loadRadar(false).catch(function (err) { status(err.message, true); });
        loadDjShow().then(paintDjCard).catch(function () {});
      }
      startPoll();
      var readyMsg = state.spotify && state.spotify.connected ? "Spotify prêt." : "Musique prêt.";
      if (state.spotify && state.spotify.connected && !(state.devices || []).length) {
        readyMsg = "Spotify connecté, mais aucun appareil visible — ouvre Spotify quelque part puis actualise.";
      }
      status(readyMsg);
      if (location.hash.indexOf("spotify=connected") >= 0) {
        status("Compte Spotify connecté.");
      }
    } catch (err) {
      render();
      status(err.message || "Erreur Musique", true);
    }
  }

  function ensureCss() {
    if (document.getElementById("hq-music-css")) return;
    var link = document.createElement("link");
    link.id = "hq-music-css";
    link.rel = "stylesheet";
    link.href = "/assets/hq-music.css";
    document.head.appendChild(link);
  }

  root.HqMusic = {
    mount: function (host, opts) {
      if (!host || !opts || typeof opts.request !== "function") {
        throw new Error("HqMusic requires a host and authenticated request adapter");
      }
      ensureCss();
      state.host = host;
      state.request = opts.request;
      state.shown = true;
      if (!host.dataset.hqmAudioBound) {
        host.dataset.hqmAudioBound = "1";
        host.addEventListener("pointerdown", unlockAudio, true);
        host.addEventListener("keydown", unlockAudio, true);
      }
      bindMatchKeys();
      state.tab = takeTabHint();
      state.renderedTab = null;
      bindMusicViewport();
      return bootstrap();
    },
    unmount: function (host) {
      if (host && state.host !== host) return;
      if (state.micCancel) state.micCancel();
      stopPoll();
      stopStudioPoll();
      cancelSleep(true);
      if (state.prepTimer) { clearInterval(state.prepTimer); state.prepTimer = null; }
      if (state.djWatch) { clearInterval(state.djWatch); state.djWatch = null; }
      if (state.awaitTimer) { clearInterval(state.awaitTimer); state.awaitTimer = null; }
      state.shown = false;
      state.topbarTop = null;
      document.body.classList.remove("hqm-keyboard-open");
      document.documentElement.style.setProperty("--hq-kb", "0px");
      if (state.host) state.host.replaceChildren();
      state.host = null;
      state.request = null;
    },
    show: function () {
      if (!state.host) return;
      state.shown = true;
      return bootstrap();
    },
    hide: function () {
      if (state.micCancel) state.micCancel();
      stopPoll();
      stopStudioPoll();
      state.shown = false;
    },
    refresh: function () { return bootstrap(); }
  };

  root.hqMusicShow = function () {
    var host = document.getElementById("hq-music-app");
    if (!host) return;
    if (!root.HqMusic || !state.request) {
      if (typeof root.hqMusicEnsureMounted === "function") root.hqMusicEnsureMounted();
    }
    if (root.HqMusic) root.HqMusic.show();
  };
  root.hqMusicHide = function () {
    if (root.HqMusic) root.HqMusic.hide();
  };
})(typeof window !== "undefined" ? window : globalThis);
