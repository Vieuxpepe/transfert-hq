/* Transfert HQ — the one place that decides which song Musica is hearing.
 *
 * Two features name a song: the beat engine stores a grid key (beatKey) and the chip's speech asks the model
 * about "the current track". When they derived that key differently, the dance pack was thrown away mid-track
 * and she spoke about the previous song. Everything now goes through this module:
 *   - localKey() is the beat-grid key, byte-identical to what syncBeatKey() stores;
 *   - identity() resolves local vs Spotify once, with the local file of the Lecteur tab winning;
 *   - remember() tracks how long the song has been stable and announces changes on hq:now-playing;
 *   - filterLines() rejects a generated line that names another track (model drift, not just client drift).
 */
(function (root, factory) {
  "use strict";
  const api = factory(root);
  if (typeof module === "object" && module && module.exports) module.exports = api;
  else root.HqNowPlaying = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (global) {
  "use strict";

  function hashHex(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  // The local key is the beat-grid key: same hash, same prefix, same source path.
  function localKey(src) {
    const clean = String(src || "").split("#")[0];
    if (!clean) return "";
    return "l-" + hashHex(clean) + hashHex(clean.length + ":" + clean.split("").reverse().join(""));
  }

  function spotifyKey(trackId) {
    const id = String(trackId || "");
    if (!id) return "";
    return "s-" + id.replace(/[^A-Za-z0-9:_-]/g, "_").slice(-78);
  }

  // Local playback wins when the Lecteur tab is showing a file; otherwise the Spotify snapshot is the song.
  function identity(input) {
    const view = String((input && input.view) || "");
    const src = String((input && input.src) || "");
    const playback = (input && input.playback) || {};
    if (view === "lecteur" && src) {
      return { key: localKey(src), title: "", artist: "", local: true };
    }
    return {
      key: spotifyKey(playback.trackId),
      title: String(playback.track || ""),
      artist: String(playback.artist || ""),
      local: false
    };
  }

  const state = { key: "", since: 0, last: null };

  // How long has this song been the song? The chip refuses to talk about a track it met one second ago.
  function remember(snapshot, now) {
    const at = Number.isFinite(now) ? now : Date.now();
    const key = String((snapshot && snapshot.key) || "");
    let changed = false;
    if (key !== state.key) {
      state.key = key;
      state.since = key ? at : 0;
      changed = true;
    }
    const next = Object.assign({}, snapshot, {
      key: key,
      stableMs: state.since ? Math.max(0, at - state.since) : 0
    });
    state.last = next;
    if (changed && key && typeof global.dispatchEvent === "function" && global.CustomEvent) {
      try {
        global.dispatchEvent(new global.CustomEvent("hq:now-playing", { detail: next }));
      } catch (_) { /* a listener failed: the identity is still valid */ }
    }
    return next;
  }

  function normalise(text) {
    return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
  }

  const QUOTED = /[\u201c"\u00ab]\s*([^\u201d"\u00bb]{2,80})\s*[\u201d"\u00bb]/g;
  const RECENT_PHRASES = /\b(recently played|last (?:track|song)|the previous (?:song|track)|you were playing|earlier you (?:were|played)|derni[eè]re (?:chanson|piste)|tout [àa] l'heure on a)\b/i;

  // True when a line refers to a track that is not the one playing right now.
  function mentionsOtherTitle(text, title) {
    const body = String(text || "");
    if (!body) return false;
    if (RECENT_PHRASES.test(body)) return true;
    const own = normalise(title);
    let other = false;
    body.replace(QUOTED, function (all, inner) {
      const name = normalise(inner);
      if (!name) return all;
      if (!own) { other = true; return all; }          // no known title: never trust a quoted track
      if (name.indexOf(own) >= 0 || own.indexOf(name) >= 0) return all;
      other = true;
      return all;
    });
    return other;
  }

  function filterLines(lines, title) {
    const list = Array.isArray(lines) ? lines : [];
    return list.filter(function (line) {
      return typeof line === "string" && line.length >= 6 && !mentionsOtherTitle(line, title);
    });
  }

  // The owner can pin the title she should use for a song (right-click on the chip). Scoped to the key that was
  // playing when he set it, so it never leaks onto the next track.
  let override = null;
  function setOverride(next) {
    override = next && String(next.title || "").trim()
      ? { key: String(next.key || ""), title: String(next.title).trim().slice(0, 120), artist: String(next.artist || "").trim().slice(0, 120) }
      : null;
    // A fresh edit is newer than the copy fetched from the server: it must win until the POST answers.
    if (override && override.key) serverTitles.delete(override.key);
    try { global.localStorage.setItem("hq_musica-song-override", override ? JSON.stringify(override) : ""); } catch (_) {}
    return override;
  }
  function loadOverride() {
    try {
      const raw = global.localStorage.getItem("hq_musica-song-override");
      override = raw ? JSON.parse(raw) : null;
      if (!override || !override.title) override = null;
    } catch (_) { override = null; }
    return override;
  }
  // The server keeps the same override in .hq-music state; a device asks for it once per song and caches it here.
  const serverTitles = new Map();
  function setServerOverride(key, entry) {
    const clean = String(key || "");
    if (!clean) return null;
    if (entry && String(entry.title || "").trim()) {
      serverTitles.set(clean, {
        key: clean,
        title: String(entry.title).trim().slice(0, 120),
        artist: String(entry.artist || "").trim().slice(0, 120)
      });
    } else {
      serverTitles.delete(clean);
    }
    return serverTitles.get(clean) || null;
  }
  function overrideFor(key) {
    const clean = String(key || "");
    if (clean && serverTitles.has(clean)) return serverTitles.get(clean);
    if (!override) return null;
    if (!clean || !override.key || override.key === clean) return override;
    return null;
  }

  // A blind tournament match conceals the song: no speaker may name it. One flag, owned here so every surface
  // reads the same answer instead of sharing a loose window global.
  let concealLocal = false;
  let concealServer = false;
  function conceal(on) {
    concealLocal = Boolean(on);
    return isConcealed();
  }
  // The station sets this from /api/musica/conceal, so a blind duel hides the song on every view, not just Musique.
  function concealFromServer(on) {
    concealServer = Boolean(on);
    return isConcealed();
  }
  function isConcealed() { return concealLocal || concealServer; }

  return {
    conceal: conceal,
    concealFromServer: concealFromServer,
    isConcealed: isConcealed,
    setOverride: setOverride,
    setServerOverride: setServerOverride,
    loadOverride: loadOverride,
    overrideFor: overrideFor,
    hashHex: hashHex,
    localKey: localKey,
    spotifyKey: spotifyKey,
    identity: identity,
    remember: remember,
    mentionsOtherTitle: mentionsOtherTitle,
    filterLines: filterLines,
    current: function () { return state.last; },
    reset: function () { state.key = ""; state.since = 0; state.last = null; }
  };
});
