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
    abort: null,
    spotify: null,
    player: null,
    devices: [],
    playlists: [],
    playlistOffset: 0,
    playlistTotal: 0,
    openPlaylist: null,
    tracks: [],
    trackOffset: 0,
    searchResults: null,
    session: null,
    presets: [],
    favorites: null,
    profile: null,
    discoveries: [],
    mixerSources: [],
    mixerConfig: {
      length: 30,
      familiarity: 0.5,
      artist_window: 3,
      favorites_boost: 0.15,
      max_artist_frequency: 3,
      seed: ""
    }
  };

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

  async function call(path, method, body) {
    if (typeof state.request !== "function") throw new Error("API adapter required");
    var response = await state.request({ path: path, method: method || "GET", body: body });
    var data = response && (response.body || response);
    if (!data || data.ok === false) {
      var err = new Error((data && data.error) || "Music API unavailable");
      err.code = data && data.code;
      err.status = response && response.status;
      throw err;
    }
    return data;
  }

  function stopPoll() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPoll() {
    stopPoll();
    if (!state.shown || state.tab !== "lecture") return;
    state.pollTimer = setInterval(function () {
      if (!state.shown || document.hidden || state.tab !== "lecture") return;
      refreshPlayer(true).catch(function () {});
    }, 5000);
  }

  async function refreshStatus() {
    state.spotify = await call("/api/spotify/status");
    return state.spotify;
  }

  async function refreshPlayer(silent) {
    try {
      state.player = await call("/api/spotify/player");
      if (!silent && state.tab === "lecture") render();
      else if (silent) updateNowPlayingDom();
    } catch (err) {
      if (!silent) throw err;
    }
  }

  function updateNowPlayingDom() {
    if (!state.host) return;
    var title = state.host.querySelector("[data-hqm='track-title']");
    var artist = state.host.querySelector("[data-hqm='track-artist']");
    var album = state.host.querySelector("[data-hqm='track-album']");
    var progress = state.host.querySelector("[data-hqm='progress']");
    var times = state.host.querySelector("[data-hqm='times']");
    var art = state.host.querySelector("[data-hqm='art']");
    var item = (state.player && state.player.item) || null;
    if (title) title.textContent = item ? item.name : "Rien en lecture";
    if (artist) artist.textContent = item && item.artists ? item.artists.join(", ") : "—";
    if (album) album.textContent = item && item.album ? item.album : "";
    if (art) {
      if (item && item.image) {
        art.src = item.image;
        art.hidden = false;
      } else {
        art.removeAttribute("src");
        art.hidden = true;
      }
    }
    if (progress && item) {
      progress.max = item.duration_ms || 0;
      progress.value = (state.player && state.player.progress_ms) || 0;
    }
    if (times) {
      times.textContent = item
        ? fmtMs(state.player && state.player.progress_ms) + " / " + fmtMs(item.duration_ms)
        : "";
    }
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

  async function playerAction(action, extra) {
    var body = Object.assign({ action: action }, extra || {});
    await call("/api/spotify/player", "POST", body);
    await refreshPlayer(false);
  }

  async function loadDevices() {
    var data = await call("/api/spotify/devices");
    state.devices = data.devices || [];
  }

  async function loadPlaylists(reset) {
    if (reset) {
      state.playlistOffset = 0;
      state.playlists = [];
    }
    var q = "";
    var input = state.host && state.host.querySelector("[data-hqm='playlist-search']");
    if (input) q = input.value.trim();
    var data = await call(
      "/api/spotify/playlists?limit=30&offset=" + state.playlistOffset + (q ? "&q=" + encodeURIComponent(q) : "")
    );
    state.playlists = (reset ? [] : state.playlists).concat(data.items || []);
    state.playlistTotal = data.total || state.playlists.length;
    state.playlistOffset = state.playlists.length;
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

  async function searchCatalog() {
    var input = state.host.querySelector("[data-hqm='catalog-search']");
    var q = input ? input.value.trim() : "";
    if (!q) {
      state.searchResults = null;
      render();
      return;
    }
    state.searchResults = await call("/api/spotify/search?q=" + encodeURIComponent(q) + "&limit=20");
    render();
  }

  async function loadMixerData() {
    var results = await Promise.all([
      call("/api/music/presets"),
      call("/api/music/favorites"),
      call("/api/music/session")
    ]);
    state.presets = results[0].presets || [];
    state.favorites = results[1].favorites || { tracks: [], artists: [], playlists: [] };
    state.session = results[2].session || null;
    if (!state.mixerSources.length && state.playlists.length) {
      // leave empty until user adds
    }
  }

  async function generateSession() {
    if (!state.mixerSources.length) throw new Error("Ajoute au moins une playlist source");
    status("Génération de la session…");
    var config = Object.assign({}, state.mixerConfig);
    if (config.seed === "" || config.seed == null) delete config.seed;
    else config.seed = Number(config.seed);
    var data = await call("/api/music/session/generate", "POST", {
      sources: state.mixerSources.map(function (s) {
        return { playlist_id: s.id, name: s.name, weight: Number(s.weight) || 1 };
      }),
      config: config
    });
    state.session = data.session;
    status("Session générée (" + ((state.session.tracks || []).length) + " titres).");
    render();
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
    await playerAction("play", { uris: uris });
    status("Lecture démarrée sur l'appareil actif.");
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

  function setTab(tab) {
    state.tab = tab;
    render();
    if (tab === "lecture") startPoll();
    else stopPoll();
    if (tab === "playlists" && state.spotify && state.spotify.connected && !state.playlists.length) {
      loadPlaylists(true).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "mixer") {
      Promise.all([
        state.playlists.length ? Promise.resolve() : loadPlaylists(true).catch(function () {}),
        loadMixerData()
      ]).then(render).catch(function (e) { status(e.message, true); });
    }
    if (tab === "decouvertes") {
      loadDiscoveries().then(render).catch(function (e) { status(e.message, true); });
    }
  }

  function renderDisconnected(host) {
    var card = el("section", "hqm-card");
    card.appendChild(el("h3", "", "Connexion Spotify"));
    var conf = state.spotify || {};
    if (!conf.configured) {
      card.appendChild(el("p", "", "Spotify n'est pas encore configuré sur ce pont."));
      card.appendChild(el("p", "hqm-muted", "Ajoute spotify_client_id (et optionnellement spotify_client_secret, spotify_redirect_uri) dans bridge_config.json ou les variables d'environnement, puis redéclare l'URI de redirection dans le Spotify Developer Dashboard."));
      if (conf.redirect_uri) card.appendChild(el("p", "hqm-muted", "URI attendue : " + conf.redirect_uri));
    } else {
      card.appendChild(el("p", "", "Connecte ton compte Spotify Premium pour piloter la lecture, les appareils Connect et les playlists."));
      card.appendChild(btn("Connecter Spotify", "hqm-btn", function () {
        connectSpotify().catch(function (e) { status(e.message, true); });
      }));
    }
    host.appendChild(card);
  }

  function renderLecture(host) {
    if (!state.spotify || !state.spotify.connected) {
      renderDisconnected(host);
      return;
    }
    var account = el("section", "hqm-card");
    account.appendChild(el("h3", "", "Compte"));
    var badge = el("span", "hqm-badge ok", state.spotify.display_name || "Connecté");
    account.appendChild(badge);
    account.appendChild(el("p", "hqm-muted",
      (state.spotify.product ? ("Offre : " + state.spotify.product + " · ") : "") +
      (state.spotify.email || "")
    ));
    var row = el("div", "hqm-row");
    row.appendChild(btn("Reconnecter", "hqm-btn secondary", function () {
      connectSpotify().catch(function (e) { status(e.message, true); });
    }));
    row.appendChild(btn("Déconnecter", "hqm-btn secondary", function () {
      disconnectSpotify().catch(function (e) { status(e.message, true); });
    }));
    account.appendChild(row);
    host.appendChild(account);

    var now = el("section", "hqm-card");
    now.appendChild(el("h3", "", "En lecture"));
    var box = el("div", "hqm-now");
    var art = el("img", "hqm-art");
    art.setAttribute("data-hqm", "art");
    art.alt = "";
    art.hidden = true;
    box.appendChild(art);
    var meta = el("div", "hqm-track-meta");
    var title = el("strong", "");
    title.setAttribute("data-hqm", "track-title");
    var artist = el("span", "");
    artist.setAttribute("data-hqm", "track-artist");
    var album = el("span", "");
    album.setAttribute("data-hqm", "track-album");
    meta.appendChild(title);
    meta.appendChild(artist);
    meta.appendChild(album);
    var times = el("span", "hqm-muted");
    times.setAttribute("data-hqm", "times");
    meta.appendChild(times);
    box.appendChild(meta);
    now.appendChild(box);
    var progress = document.createElement("input");
    progress.type = "range";
    progress.className = "hqm-progress";
    progress.setAttribute("data-hqm", "progress");
    progress.setAttribute("aria-label", "Position");
    progress.min = "0";
    progress.value = "0";
    progress.addEventListener("change", function () {
      playerAction("seek", { position_ms: Number(progress.value) || 0 }).catch(function (e) { status(e.message, true); });
    });
    now.appendChild(progress);

    var controls = el("div", "hqm-row");
    [
      ["⏮", "previous", "Précédent"],
      ["⏯", "toggle", "Lecture / Pause"],
      ["⏭", "next", "Suivant"]
    ].forEach(function (item) {
      controls.appendChild(btn(item[0], "hqm-icon-btn", function () {
        var action = item[1] === "toggle"
          ? ((state.player && state.player.playing) ? "pause" : "play")
          : item[1];
        playerAction(action).catch(function (e) { status(e.message, true); });
      })).setAttribute("aria-label", item[2]);
    });
    now.appendChild(controls);

    var extras = el("div", "hqm-row");
    extras.appendChild(btn("Aléatoire", "hqm-btn secondary", function () {
      var on = !(state.player && state.player.shuffle_state);
      playerAction("shuffle", { state: on }).catch(function (e) { status(e.message, true); });
    }));
    extras.appendChild(btn("Répéter", "hqm-btn secondary", function () {
      var cur = (state.player && state.player.repeat_state) || "off";
      var next = cur === "off" ? "context" : (cur === "context" ? "track" : "off");
      playerAction("repeat", { state: next }).catch(function (e) { status(e.message, true); });
    }));
    var vol = document.createElement("input");
    vol.type = "range";
    vol.min = "0";
    vol.max = "100";
    vol.value = String((state.player && state.player.device && state.player.device.volume_percent) || 50);
    vol.setAttribute("aria-label", "Volume");
    vol.style.maxWidth = "160px";
    vol.addEventListener("change", function () {
      playerAction("volume", { volume_percent: Number(vol.value) }).catch(function (e) { status(e.message, true); });
    });
    extras.appendChild(vol);
    now.appendChild(extras);
    host.appendChild(now);
    updateNowPlayingDom();

    var devices = el("section", "hqm-card");
    devices.appendChild(el("h3", "", "Spotify Connect"));
    var refreshDev = btn("Actualiser appareils", "hqm-btn secondary", function () {
      loadDevices().then(render).catch(function (e) { status(e.message, true); });
    });
    devices.appendChild(refreshDev);
    if (!state.devices.length) {
      devices.appendChild(el("p", "hqm-muted", "Aucun appareil visible. Ouvre Spotify sur un téléphone, PC ou enceinte, puis actualise."));
    } else {
      var list = el("ul", "hqm-list");
      state.devices.forEach(function (d) {
        var li = el("li", "");
        var metaD = el("div", "hqm-track-meta");
        metaD.appendChild(el("strong", "", (d.name || "Appareil") + (d.is_active ? " · actif" : "")));
        metaD.appendChild(el("span", "", (d.type || "") + (d.is_restricted ? " · restreint" : "")));
        li.appendChild(metaD);
        if (!d.is_restricted) {
          li.appendChild(btn(d.is_active ? "Actif" : "Transférer", "hqm-btn secondary", function () {
            playerAction("transfer", { device_id: d.id, play: true }).then(function () {
              return loadDevices();
            }).then(render).catch(function (e) { status(e.message, true); });
          }));
        }
        list.appendChild(li);
      });
      devices.appendChild(list);
    }
    host.appendChild(devices);

    var queueCard = el("section", "hqm-card");
    queueCard.appendChild(el("h3", "", "File d'attente"));
    queueCard.appendChild(el("p", "hqm-muted", "Spotify expose la file en lecture, sans réorganisation libre via l'API publique."));
    call("/api/spotify/queue").then(function (data) {
      if (!state.shown || state.tab !== "lecture") return;
      var list = el("ul", "hqm-list");
      (data.queue || []).slice(0, 20).forEach(function (t) {
        var li = el("li", "");
        var metaQ = el("div", "hqm-track-meta");
        metaQ.appendChild(el("strong", "", t.name || "?"));
        metaQ.appendChild(el("span", "", (t.artists || []).join(", ")));
        li.appendChild(metaQ);
        list.appendChild(li);
      });
      if (!(data.queue || []).length) list.appendChild(el("li", "hqm-muted", "File vide ou indisponible."));
      queueCard.appendChild(list);
    }).catch(function () {
      queueCard.appendChild(el("p", "hqm-muted", "File indisponible pour le moment."));
    });
    host.appendChild(queueCard);
  }

  function renderPlaylists(host) {
    if (!state.spotify || !state.spotify.connected) {
      renderDisconnected(host);
      return;
    }
    var grid = el("div", "hqm-grid-2");
    var left = el("section", "hqm-card");
    left.appendChild(el("h3", "", "Playlists"));
    var searchRow = el("div", "hqm-row");
    var search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Filtrer mes playlists…";
    search.setAttribute("data-hqm", "playlist-search");
    search.setAttribute("aria-label", "Filtrer les playlists");
    searchRow.appendChild(search);
    searchRow.appendChild(btn("Chercher", "hqm-btn secondary", function () {
      loadPlaylists(true).then(render).catch(function (e) { status(e.message, true); });
    }));
    left.appendChild(searchRow);

    var createRow = el("div", "hqm-row");
    var createName = document.createElement("input");
    createName.type = "text";
    createName.placeholder = "Nouvelle playlist";
    createName.setAttribute("aria-label", "Nom de la nouvelle playlist");
    createRow.appendChild(createName);
    createRow.appendChild(btn("Créer", "hqm-btn", function () {
      call("/api/spotify/playlists", "POST", { name: createName.value, public: false })
        .then(function () { return loadPlaylists(true); })
        .then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    left.appendChild(createRow);

    var list = el("ul", "hqm-list");
    state.playlists.forEach(function (pl) {
      var li = el("li", "");
      var meta = el("div", "hqm-track-meta");
      meta.appendChild(el("strong", "", pl.name || "Playlist"));
      meta.appendChild(el("span", "", (pl.tracks_total != null ? pl.tracks_total + " titres" : "") + (pl.owner ? " · " + pl.owner : "")));
      li.appendChild(meta);
      var actions = el("div", "hqm-row");
      actions.appendChild(btn("Ouvrir", "hqm-btn secondary", function () {
        openPlaylist(pl.id).then(render).catch(function (e) { status(e.message, true); });
      }));
      actions.appendChild(btn("Mixer+", "hqm-btn secondary", function () {
        if (!state.mixerSources.some(function (s) { return s.id === pl.id; })) {
          state.mixerSources.push({ id: pl.id, name: pl.name, weight: 1 });
        }
        setTab("mixer");
      }));
      li.appendChild(actions);
      list.appendChild(li);
    });
    left.appendChild(list);
    if (state.playlists.length < state.playlistTotal) {
      left.appendChild(btn("Charger plus", "hqm-btn secondary", function () {
        loadPlaylists(false).then(render).catch(function (e) { status(e.message, true); });
      }));
    }
    grid.appendChild(left);

    var right = el("section", "hqm-card");
    right.appendChild(el("h3", "", state.openPlaylist ? state.openPlaylist.name : "Détail / Recherche catalogue"));
    if (state.openPlaylist) {
      right.appendChild(el("p", "hqm-muted", state.openPlaylist.description || ""));
      var rename = document.createElement("input");
      rename.type = "text";
      rename.value = state.openPlaylist.name || "";
      rename.setAttribute("aria-label", "Renommer la playlist");
      right.appendChild(rename);
      var desc = document.createElement("textarea");
      desc.value = state.openPlaylist.description || "";
      desc.setAttribute("aria-label", "Description");
      right.appendChild(desc);
      right.appendChild(btn("Enregistrer métadonnées", "hqm-btn secondary", function () {
        call("/api/spotify/playlists/" + encodeURIComponent(state.openPlaylist.id), "POST", {
          name: rename.value,
          description: desc.value
        }).then(function () { return openPlaylist(state.openPlaylist.id); })
          .then(render)
          .catch(function (e) { status(e.message, true); });
      }));
      right.appendChild(btn("Lire la playlist", "hqm-btn", function () {
        playerAction("play", { context_uri: state.openPlaylist.uri || ("spotify:playlist:" + state.openPlaylist.id) })
          .catch(function (e) { status(e.message, true); });
      }));
      var tracks = el("ul", "hqm-list");
      state.tracks.forEach(function (t, idx) {
        var li = el("li", "hqm-track");
        var meta = el("div", "hqm-track-meta");
        meta.appendChild(el("strong", "", t.name || "?"));
        meta.appendChild(el("span", "", (t.artists || []).join(", ")));
        li.appendChild(meta);
        var actions = el("div", "hqm-row");
        actions.appendChild(btn("▶", "hqm-icon-btn", function () {
          playerAction("play", { uris: [t.uri] }).catch(function (e) { status(e.message, true); });
        }));
        actions.appendChild(btn("+file", "hqm-btn secondary", function () {
          playerAction("queue_add", { uri: t.uri }).then(function () { status("Ajouté à la file."); })
            .catch(function (e) { status(e.message, true); });
        }));
        actions.appendChild(btn("Retirer", "hqm-btn secondary", function () {
          call("/api/spotify/playlists/" + encodeURIComponent(state.openPlaylist.id) + "/tracks", "POST", {
            op: "remove",
            tracks: [{ uri: t.uri, positions: [idx] }]
          }).then(function () { return openPlaylist(state.openPlaylist.id); })
            .then(render)
            .catch(function (e) { status(e.message, true); });
        }));
        li.appendChild(actions);
        tracks.appendChild(li);
      });
      right.appendChild(tracks);
      if ((state.openPlaylist.tracks_total || 0) > state.tracks.length) {
        right.appendChild(btn("Charger plus de titres", "hqm-btn secondary", function () {
          loadPlaylistTracks(false).then(render).catch(function (e) { status(e.message, true); });
        }));
      }
    }

    var catalog = el("div", "hqm-field");
    catalog.appendChild(el("label", "hqm-label", "Recherche catalogue Spotify"));
    var catSearch = document.createElement("input");
    catSearch.type = "search";
    catSearch.setAttribute("data-hqm", "catalog-search");
    catSearch.placeholder = "Titre, artiste, album, playlist…";
    catalog.appendChild(catSearch);
    catalog.appendChild(btn("Rechercher", "hqm-btn secondary", function () {
      searchCatalog().catch(function (e) { status(e.message, true); });
    }));
    right.appendChild(catalog);
    if (state.searchResults) {
      var res = el("ul", "hqm-list");
      (state.searchResults.tracks || []).forEach(function (t) {
        var li = el("li", "");
        var meta = el("div", "hqm-track-meta");
        meta.appendChild(el("strong", "", t.name || "?"));
        meta.appendChild(el("span", "", (t.artists || []).join(", ")));
        li.appendChild(meta);
        var actions = el("div", "hqm-row");
        actions.appendChild(btn("▶", "hqm-icon-btn", function () {
          playerAction("play", { uris: [t.uri] }).catch(function (e) { status(e.message, true); });
        }));
        if (state.openPlaylist) {
          actions.appendChild(btn("Ajouter", "hqm-btn secondary", function () {
            call("/api/spotify/playlists/" + encodeURIComponent(state.openPlaylist.id) + "/tracks", "POST", {
              op: "add",
              uris: [t.uri]
            }).then(function () { status("Ajouté à la playlist."); })
              .catch(function (e) { status(e.message, true); });
          }));
        }
        li.appendChild(actions);
        res.appendChild(li);
      });
      right.appendChild(res);
    }
    grid.appendChild(right);
    host.appendChild(grid);
  }

  function renderMixer(host) {
    var card = el("section", "hqm-card");
    card.appendChild(el("h3", "", "Mixer — DJ personnel"));
    card.appendChild(el("p", "hqm-muted", "Mélange pondéré de tes playlists. N'utilise pas les API recommendations/audio-features dépréciées."));

    var addRow = el("div", "hqm-row");
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Playlist source");
    select.appendChild(new Option("Choisir une playlist…", ""));
    state.playlists.forEach(function (pl) {
      select.appendChild(new Option(pl.name, pl.id));
    });
    addRow.appendChild(select);
    addRow.appendChild(btn("Ajouter source", "hqm-btn secondary", function () {
      var id = select.value;
      if (!id) return;
      var pl = state.playlists.find(function (p) { return p.id === id; });
      if (!pl) return;
      if (!state.mixerSources.some(function (s) { return s.id === id; })) {
        state.mixerSources.push({ id: pl.id, name: pl.name, weight: 1 });
        render();
      }
    }));
    card.appendChild(addRow);

    state.mixerSources.forEach(function (src, index) {
      var row = el("div", "hqm-source");
      row.appendChild(el("div", "", src.name));
      var weight = document.createElement("input");
      weight.type = "number";
      weight.min = "0";
      weight.step = "0.1";
      weight.value = String(src.weight);
      weight.setAttribute("aria-label", "Poids " + src.name);
      weight.addEventListener("change", function () {
        state.mixerSources[index].weight = Number(weight.value) || 0;
      });
      row.appendChild(weight);
      row.appendChild(btn("Retirer", "hqm-btn secondary", function () {
        state.mixerSources.splice(index, 1);
        render();
      }));
      card.appendChild(row);
    });

    var cfg = el("div", "hqm-grid-2");
    function numField(key, label, min, max, step) {
      var field = el("div", "hqm-field");
      field.appendChild(el("label", "hqm-label", label));
      var input = document.createElement("input");
      input.type = "number";
      input.min = String(min);
      input.max = String(max);
      input.step = String(step || 1);
      input.value = String(state.mixerConfig[key]);
      input.addEventListener("change", function () {
        state.mixerConfig[key] = Number(input.value);
      });
      field.appendChild(input);
      return field;
    }
    cfg.appendChild(numField("length", "Longueur session", 1, 100, 1));
    cfg.appendChild(numField("familiarity", "Familiarité (0–1)", 0, 1, 0.05));
    cfg.appendChild(numField("artist_window", "Fenêtre anti-artiste", 0, 20, 1));
    cfg.appendChild(numField("max_artist_frequency", "Max titres / artiste", 1, 20, 1));
    cfg.appendChild(numField("favorites_boost", "Boost favoris", 0, 1, 0.05));
    var seedField = el("div", "hqm-field");
    seedField.appendChild(el("label", "hqm-label", "Graine (optionnel)"));
    var seed = document.createElement("input");
    seed.type = "text";
    seed.value = state.mixerConfig.seed == null ? "" : String(state.mixerConfig.seed);
    seed.addEventListener("change", function () { state.mixerConfig.seed = seed.value; });
    seedField.appendChild(seed);
    cfg.appendChild(seedField);
    card.appendChild(cfg);

    var actions = el("div", "hqm-row");
    actions.appendChild(btn("Générer session", "hqm-btn", function () {
      generateSession().catch(function (e) { status(e.message, true); });
    }));
    actions.appendChild(btn("Relancer", "hqm-btn secondary", function () {
      state.mixerConfig.seed = "";
      generateSession().catch(function (e) { status(e.message, true); });
    }));
    actions.appendChild(btn("Lire session", "hqm-btn secondary", function () {
      playSession().catch(function (e) { status(e.message, true); });
    }));
    actions.appendChild(btn("Sauver en playlist Spotify", "hqm-btn secondary", function () {
      saveSessionAsPlaylist().catch(function (e) { status(e.message, true); });
    }));
    card.appendChild(actions);
    host.appendChild(card);

    var presets = el("section", "hqm-card");
    presets.appendChild(el("h3", "", "Préréglages"));
    var presetRow = el("div", "hqm-row");
    (state.presets || []).forEach(function (p) {
      presetRow.appendChild(btn(p.name || p.id, "hqm-btn secondary", function () {
        if (p.config) state.mixerConfig = Object.assign({}, state.mixerConfig, p.config, { seed: "" });
        if (Array.isArray(p.sources) && p.sources.length) {
          state.mixerSources = p.sources.map(function (s) {
            return { id: s.playlist_id || s.id, name: s.name || s.id, weight: s.weight || 1 };
          }).filter(function (s) { return s.id; });
        }
        render();
        status("Préréglage chargé : " + (p.name || p.id));
      }));
    });
    presets.appendChild(presetRow);
    var saveName = document.createElement("input");
    saveName.type = "text";
    saveName.placeholder = "Nom du préréglage";
    presets.appendChild(saveName);
    presets.appendChild(btn("Sauver préréglage actuel", "hqm-btn", function () {
      call("/api/music/presets", "POST", {
        op: "upsert",
        preset: {
          id: (saveName.value || "custom").toLowerCase().replace(/\s+/g, "-").slice(0, 40),
          name: saveName.value || "Personnalisé",
          sources: state.mixerSources,
          config: state.mixerConfig
        }
      }).then(function () { return loadMixerData(); })
        .then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    host.appendChild(presets);

    if (state.session && state.session.tracks) {
      var preview = el("section", "hqm-card");
      preview.appendChild(el("h3", "", "Aperçu session"));
      if ((state.session.compromises || []).length) {
        preview.appendChild(el("p", "hqm-muted", "Compromis : " + state.session.compromises.join(" · ")));
      }
      var list = el("ul", "hqm-list");
      state.session.tracks.forEach(function (t) {
        var li = el("li", "");
        var meta = el("div", "hqm-track-meta");
        meta.appendChild(el("strong", "", (t.position || "") + ". " + (t.name || "?")));
        meta.appendChild(el("span", "", (t.artists || []).join(", ") + " · " + (t.source_name || "")));
        meta.appendChild(el("span", "hqm-reason", t.reason || ""));
        li.appendChild(meta);
        list.appendChild(li);
      });
      preview.appendChild(list);
      host.appendChild(preview);
    }
  }

  function renderDiscoveries(host) {
    var prefs = el("section", "hqm-card");
    prefs.appendChild(el("h3", "", "Préférences"));
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
    prefs.appendChild(listField("favorite_artists", "Artistes favoris (virgules)"));
    prefs.appendChild(listField("preferred_genres", "Genres préférés (virgules)"));
    prefs.appendChild(listField("musical_patterns", "Motifs musicaux (virgules)"));
    prefs.appendChild(btn("Enregistrer préférences", "hqm-btn", function () {
      var payload = {};
      prefs.querySelectorAll("[data-hqm-pref]").forEach(function (input) {
        payload[input.getAttribute("data-hqm-pref")] = input.value.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
      });
      call("/api/music/profile", "POST", payload)
        .then(function () { return loadDiscoveries(); })
        .then(function () { status("Préférences enregistrées."); render(); })
        .catch(function (e) { status(e.message, true); });
    }));
    host.appendChild(prefs);

    var disc = el("section", "hqm-card");
    disc.appendChild(el("h3", "", "Découvertes"));
    var suggestion = state.discoveryQuery || {};
    disc.appendChild(el("p", "hqm-muted", suggestion.ready
      ? ("Requête suggérée : " + suggestion.query)
      : "Ajoute un artiste ou un genre pour obtenir une requête de découverte."));
    disc.appendChild(el("p", "hqm-muted", "Les découvertes ne sont jamais inventées : importe uniquement des candidats vérifiés (titre + artiste + lien HTTPS)."));

    var importBox = el("div", "hqm-field");
    importBox.appendChild(el("label", "hqm-label", "Importer une découverte vérifiée"));
    var title = document.createElement("input");
    title.placeholder = "Titre";
    var artist = document.createElement("input");
    artist.placeholder = "Artiste";
    var url = document.createElement("input");
    url.placeholder = "https://…";
    importBox.appendChild(title);
    importBox.appendChild(artist);
    importBox.appendChild(url);
    importBox.appendChild(btn("Ajouter", "hqm-btn secondary", function () {
      call("/api/music/discoveries", "POST", {
        items: [{ title: title.value, artist: artist.value, source_url: url.value, confidence: 0.7 }]
      }).then(function () { return loadDiscoveries(); })
        .then(render)
        .catch(function (e) { status(e.message, true); });
    }));
    disc.appendChild(importBox);

    var list = el("ul", "hqm-list");
    (state.discoveries || []).slice().reverse().slice(0, 40).forEach(function (item) {
      var li = el("li", "");
      var meta = el("div", "hqm-track-meta");
      meta.appendChild(el("strong", "", item.title || "?"));
      meta.appendChild(el("span", "", (item.artist || "") + " · " + (item.status || "new")));
      li.appendChild(meta);
      var actions = el("div", "hqm-row");
      ["like", "dislike", "save", "dismiss"].forEach(function (action) {
        actions.appendChild(btn(action, "hqm-btn secondary", function () {
          Promise.resolve()
            .then(function () {
              if (action === "save" || action === "dismiss") {
                return call("/api/music/discovery-status", "POST", { id: item.id, status: action === "save" ? "saved" : "dismissed" });
              }
              return Promise.resolve();
            })
            .then(function () {
              return call("/api/music/feedback", "POST", {
                artist: item.artist,
                title: item.title,
                action: action
              });
            })
            .then(function () { return loadDiscoveries(); })
            .then(render)
            .catch(function (e) { status(e.message, true); });
        }));
      });
      if (item.source_url) {
        var link = el("a", "", "Source");
        link.href = item.source_url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        actions.appendChild(link);
      }
      li.appendChild(actions);
      list.appendChild(li);
    });
    if (!(state.discoveries || []).length) list.appendChild(el("li", "hqm-muted", "Aucune découverte enregistrée."));
    disc.appendChild(list);
    host.appendChild(disc);
  }

  function render() {
    if (!state.host || !state.shown) return;
    var host = state.host;
    host.replaceChildren();

    var header = el("div", "hqm-header");
    header.appendChild(el("h2", "", "Musique"));
    header.appendChild(el("p", "", "Contrôle Spotify natif — Lecture, Playlists, Mixer, Découvertes. Lecteur local inchangé."));
    host.appendChild(header);

    var tabs = el("div", "hqm-tabs");
    tabs.setAttribute("role", "tablist");
    [
      ["lecture", "Lecture"],
      ["playlists", "Playlists"],
      ["mixer", "Mixer"],
      ["decouvertes", "Découvertes"]
    ].forEach(function (pair) {
      var tab = btn(pair[1], "hqm-tab", function () { setTab(pair[0]); });
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", state.tab === pair[0] ? "true" : "false");
      tabs.appendChild(tab);
    });
    host.appendChild(tabs);

    var message = el("p", "hqm-status", "");
    message.setAttribute("role", "status");
    host.appendChild(message);

    var panel = el("div", "hqm-panel is-active");
    panel.setAttribute("role", "tabpanel");
    if (state.tab === "lecture") renderLecture(panel);
    else if (state.tab === "playlists") renderPlaylists(panel);
    else if (state.tab === "mixer") renderMixer(panel);
    else renderDiscoveries(panel);
    host.appendChild(panel);
  }

  async function bootstrap() {
    status("Chargement…");
    try {
      await refreshStatus();
      if (state.spotify && state.spotify.connected) {
        await Promise.all([
          refreshPlayer(true).catch(function () {}),
          loadDevices().catch(function () {})
        ]);
      }
      render();
      startPoll();
      status(state.spotify && state.spotify.connected ? "Spotify prêt." : "Musique prêt.");
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
      state.tab = "lecture";
      return bootstrap();
    },
    unmount: function (host) {
      if (host && state.host !== host) return;
      stopPoll();
      state.shown = false;
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
      stopPoll();
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
