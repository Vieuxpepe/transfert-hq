# Master prompt — Musica / Musique upgrade

> Hand this whole file to the implementing agent. It is self-contained.

---

You are upgrading **Musica**, the music-steward companion of Transfert HQ, and the
**Musique** tab she lives in. Repository: `C:\Transfert` (Python bridge + vanilla JS
assets, Windows). Work carefully, phase by phase, with tests at every phase.

## 0. Ground rules (read first)

- **Work directly in the project checkout (`C:\Transfert`) on the current branch.**
  Do **not** create a branch or a git worktree, and do not switch branches.
- **Working tree is dirty with unrelated work**, some of it already staged (e.g. the
  household files). Never stage, unstage, revert, reformat or "clean up" files you
  did not change for this task. Never run `git add -A`, `git stash`, `git checkout --`,
  `git reset` or `git clean`. Do not push or open a PR unless the owner asks.
- Read before writing: `hq_musica.py`, `hq_music.py`, `hq_music_mixer.py`,
  `hq_spotify.py`, `assets/hq-music.js`, `assets/hq-music.css`,
  `docs/musica-persona.md`, `docs/musique-spotify.md`, `docs/companion-family.md`,
  `tests/test_hq_musica.py`, `tests/test_hq_music*.py`, and the Musica/Spotify routes
  in `iphone_bridge.py` (search `hq_musica`, `/api/spotify`, `/api/music`).
- Keep existing conventions: French UI strings, `hq_state.write_json_atomic` +
  `path_lock` for state, link/junction refusal in `_path()`, admin session + CSRF on
  every POST route (follow how `/api/musica/*` is already dispatched), same-origin
  cover proxy `/api/spotify/image`, tokens never leave the server, no new runtime
  dependencies, no external CDN in the HQ app.
- Musica keeps a **separate memory** from Else / Transferania / Static. Do not
  merge stores.
- **Evidence only** stays the core rule: Musica never names a track/album/artist as
  "on Spotify" unless it came from a tool result in this conversation.
- Tests: `python -m unittest tests.test_hq_musica tests.test_hq_music tests.test_hq_music_mixer tests.test_hq_music_ui -v`
  must pass after every phase. Mock `hq_ai.generate` and `hq_spotify.api_request`;
  never hit the network in tests. Update `docs/test-index.md` and
  `docs/hq-api-route-index.md` for any new test file or route.
- Leave your changes **uncommitted** in the working tree unless the owner asks for
  commits. If asked to commit, commit only your own files with
  `git commit -- <path> <path> …` (a plain `git commit` would also sweep in the
  owner's already-staged unrelated files).

### Spotify platform reality (verify, then design defensively)

The app is a **Development Mode** Spotify app. Since the Feb 2026 Dev Mode changes
(<https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide>):
- `GET /browse/new-releases` is removed. `/v1/recommendations`,
  `/v1/audio-features`, related-artists are unavailable. Do not use them.
- Search results may be capped at **10** per request; other endpoints (artist top
  tracks, some album/artist metadata, reading other users' playlists) are reported
  removed or restricted by secondary sources.
- **Read the official migration guide first** and record what you confirmed in
  `docs/musique-spotify.md`. Then implement every Spotify call so that a 403/404/
  "endpoint removed" response degrades gracefully: the feature reports
  `code: "spotify_unavailable_endpoint"`, the UI hides or explains it, and Musica is
  told the capability is off. Clamp search `limit` to a module constant
  (`SEARCH_MAX_LIMIT = 10`) and paginate with `offset` when more is needed.

## 1. Privacy and data minimisation (do this first)

Today every Musica turn sends the profile to Gemini (`hq_ai.ASK_CHAIN`, a **free-tier
key**), and tool turns send raw results (up to 12 000 chars): track names, Spotify
URIs, proxied image URLs, playlist names, devices — and `get_status` leaks Spotify
`user_id`, `display_name`, partially redacted email, token expiry, redirect URI, the
PC **hostname** and the Spotify **install path** (contains the Windows username).
`docs/musique-spotify.md` currently says catalog/listening data must not go to AI
models — this contradicts the feature.

Implement:
1. **Reference handles.** Tool results shown to the model use short handles
   (`t1…tN` tracks, `a1…` albums, `r1…` artists, `p1…` playlists, `d1…` devices)
   instead of URIs/IDs/image URLs. The server keeps a per-thread handle map
   (persisted in `musica_thread.json`, capped, e.g. last 200 handles). Tools accept
   handles (`{"track":"t3"}`, `{"album":"a2"}`, `{"playlist":"p1"}`) and resolve
   them server-side. The model can no longer fabricate a URI because it never sees
   or emits one; reject any raw `spotify:` URI coming from the model unless it is in
   the handle map.
2. **Slim model view.** Per item send only: handle, name, artist names, album name,
   year when known, and a short `why`. No images, no URIs, no IDs, no popularity.
3. **`get_status` for the model** returns only `connected`, `product`
   (premium/free), `has_active_device`, device handles + names + types. Never
   hostname, install path, pids, user id, email, scopes, expiry, redirect URI.
4. Add a **privacy toggle** in the Musica card: "Partager l'historique d'écoute avec
   Musica" (default **on**, stored server-side in `musica_taste.json`). When off,
   listening-history tools (phase 5) are disabled for the model.
5. Rewrite the doc rule in `docs/musique-spotify.md` to state the actual policy:
   minimal catalog metadata via handles may go to the AI provider; no account
   identifiers, no machine info, no tokens; history only when the toggle is on. Note
   that the configured key is free tier and what that implies.
6. Tests: assert no `spotify:`/`open.spotify.com`/`/api/spotify/image`, hostname,
   `user_id`, or path strings ever appear in the `contents` passed to the mocked
   `hq_ai.generate`.

## 2. Agent loop that can chain steps

Today: one model call picks tools, tools run, a second call writes the reply with
tools forced to `[]`. So "joue du Sabaton" cannot search then play, and history
keeps only tool names so "joue la deuxième" fails next turn.

Implement in `hq_musica.chat`:
- Loop up to `MAX_ROUNDS = 4` model calls; each may return tools; stop when a round
  returns `tools: []` or the budget is hit (then force a final reply round).
  Keep `MAX_TOOLS_PER_TURN` as a per-round cap and add a total cap (e.g. 8).
- After each round append the slim, handle-based results to the conversation.
- Persist a compact **tool memory** in the thread: the slim results of the last few
  tool calls (handles + names) so follow-ups ("la deuxième", "plus comme ça",
  "ajoute-la à ma playlist Workout") resolve. Feed it into `_history_contents`
  (today it only sends `[outil]` + names).
- Side-effecting tools (play, queue, playlist writes, bans, preference changes) are
  allowed in the loop but each is logged in the returned `actions` list so the UI
  can show "Musica a lancé …".
- Destructive tools (remove tracks from a playlist, delete a preset, clear
  preferences) require a confirmation round-trip: the tool returns
  `needs_confirmation` with a token; the UI shows a Confirm button that calls
  `POST /api/musica/confirm`.
- Return to the UI: `reply`, `actions`, `cards` (see phase 3), `thread`.
- Tests: mocked multi-round "search then play" in one turn; follow-up "joue la
  deuxième" resolves `t2` from the previous turn; budget exhaustion produces a
  final reply; a model-invented URI is rejected.

## 3. Playable cards in the chat

`renderMusica` shows text and tool names only; tracks found are discarded.

- The chat response includes `cards`: tracks, albums, artists, playlists from this
  turn's tool results (full data for the UI, never sent to the model): cover via the
  proxy, title, artists, album/year.
- Track card actions: ▶ Lire, + File, + Playlist… (picker of the user's
  playlists), ★ Sauver découverte, 👍 / 👎. Album card: ▶ Lire l'album, Ouvrir
  (track list inline), + Playlist. Artist card: Discographie, Titres (search-based),
  Bannir. Playlist card: ▶ Lire, Ouvrir, Mixer+.
- 👍/👎 and ★ write to the unified taste store (phase 6) and Musica's next turn
  sees the feedback.
- Cards are persisted with the assistant message (cap per message, e.g. 12) so they
  survive reload, and they render with `hq-music.css` tokens in light and dark.
- Composer: Enter sends, Shift+Enter newline (keep), autoscroll to newest, "Musica
  réfléchit…" typing indicator, disabled state while busy, error bubble on failure
  with Réessayer.
- Accessibility: buttons have labels, chat log stays `aria-live="polite"`, cards
  are keyboard reachable.
- Tests: extend `tests/test_hq_music_ui.py` (or add a playwright check if the suite
  already uses them for Musique) for card rendering and actions.

## 4. Albums, artists and better search

- New Musica tools (handle-based): `search` (types track/album/artist/playlist,
  Spotify field filters allowed), `open_album`, `play_album`, `artist_albums`
  (`GET /artists/{id}/albums`, include_groups album,single), `artist_tracks`
  (search `artist:"Name"` fallback when top-tracks is unavailable), `save_album`
  (to discoveries), `add_to_playlist`, `create_playlist`.
- Expose the same in the UI: the Playlists tab catalog search gets type filters
  (Titres / Albums / Artistes / Playlists) and album/artist results become cards.
- Replace the sentence-style discovery query in `hq_music.discovery_query` with
  Spotify field syntax: `artist:"X" year:<this year>` for tracks/albums,
  `tag:new` with `type=album` for the last ~2 weeks, `genre:"g"` with
  `type=artist` for genre exploration, `tag:hipster` for low-popularity albums.
  Verify each filter still works; drop the ones that do not.
- Teach Musica the syntax in her tool schema so she builds precise queries.
- Tests for query building and for each new tool with mocked responses.

## 5. Listening-history awareness

The app already requests `user-top-read`, `user-read-recently-played`,
`user-library-read`, but no code uses them.

- Add `hq_spotify` functions: `top_artists(time_range)`, `top_tracks(time_range)`
  (short/medium/long), `recently_played(limit)`, `saved_tracks(limit, offset)`,
  `saved_albums(...)`, `followed_artists(...)` (add `user-follow-read` scope only if
  needed and document re-consent).
- Musica tools: `my_top`, `my_recent`, `my_library_check` ("do I already have
  this?"), all gated by the privacy toggle.
- A cached **taste snapshot** (`.hq-music/musica_snapshot.json`, refreshed at most
  every 12 h): top artists per range, recently played artists, saved-album count.
  The system prompt gets only a short summary (top 8 artist names). Use it to seed
  discovery and to filter out things already in the library.
- Features to enable: "tu n'as pas écouté X depuis 3 mois", "ton top du mois",
  "rien que je connais déjà" filtering.

## 6. One taste store, sane bans

Today there are three unsynchronised ban lists: Mixer bans in `localStorage`
(`hqm_banned_artists`), Musica's `musica_taste.json` bans (never applied to the
Mixer), and Mixer auto-bans derived from feedback — where a single `dismiss` on one
discovery bans that artist from every Mixer session (`hq_music.py`, "Auto-ban
artists…"). `loved_uris` / `rejected_uris` are never written.

- Make `musica_taste.json` (or a new `hq_music` taste module) the **single
  server-side source**: `banned_artists`, `loved` (track/album refs with name +
  artist), `rejected`, `seen` (discovery dedupe), `history_sharing` toggle.
- Migrate: on first load the UI posts its `localStorage` bans once, then removes
  the key. Mixer generation reads server bans.
- Change the auto-ban rule: `dismiss` = "not now" (never bans); `dislike` on a
  track lowers that track; an artist is auto-excluded only after **3 dislikes**
  across distinct tracks or an explicit ban. Show auto-excluded artists in the
  Mixer ban list with an "auto" tag and an undo.
- Routes: `GET/POST /api/music/taste` (admin, CSRF). Update the route index.

## 7. Discovery engine and new-release radar

All picks must be evidence-backed and carry a `why`.

- **Radar** (`hq_music_radar.py`): for each favourite / top artist (cap ~25),
  search `artist:"X" tag:new type=album` and `artist:"X" year:<y>`; keep releases
  not in `seen` and not in the library; store in `.hq-music/radar.json` with
  release date and source query. Run on demand (`POST /api/music/radar/run`) and
  at most once per 24 h when the Musique tab opens (no background daemon unless an
  existing HQ scheduler is the norm — check how other periodic jobs run and follow
  that). Rate-limit Spotify calls and stop cleanly on 429 using `Retry-After`.
- **"Nouveautés" panel** in Découvertes (or a new sub-tab): album cards with
  Play / Save / Ignorer; badge count on the Musique tab. Musica's greeting mentions
  new items ("3 sorties cette semaine, dont …").
- **Playlist co-occurrence discovery** (replaces related-artists): search public
  playlists for a seed artist/genre, sample their tracks, count artists that
  co-occur, exclude known/banned, return top candidates with
  `why: "présent dans 6 playlists avec Sabaton"`. If reading other users' playlists
  is blocked in Dev Mode, detect it and fall back to genre search + `tag:hipster`.
- **Exploration session**: Musica builds a 10–15 track discovery queue from radar +
  co-occurrence + genre search, saves it as a private playlist "Musica · Explorer
  <date>", plays it, and records 👍/👎 from cards; at the end she offers to save
  keepers to a "Musica · Gardés" playlist.
- Replace the manual title/artist/URL import form in Découvertes with "★ Sauver"
  on any card (keep a small advanced import behind a disclosure).
- Tests: radar dedupe, 429 backoff, co-occurrence counting, fallbacks.

## 8. Voice

- **Push-to-talk** mic button in the Musica composer using the browser
  `SpeechRecognition` / `webkitSpeechRecognition` (lang `fr-FR`, fallback `en-US`
  when the message is English). Hide the button where unsupported (Firefox) with a
  tooltip. Show live interim transcript; send on release.
- **Spoken replies** toggle ("Musica parle", persisted per device in
  `localStorage`). Prefer the existing server TTS (`hq_voice.synthesize`, see the
  `voice/speak/tts` op in `hq_ai.py`) through a new admin route
  `POST /api/musica/speak` returning an audio URL; fall back to browser
  `speechSynthesis` using the same voice-picking approach as
  `assets/hq-companion.js` (`pickVoice`). Strip card/markup text before speaking.
- **Ducking**: while she speaks, lower Spotify volume (player volume action) and
  restore it afterwards; never leave volume changed on error.
- Short hands-free intents handled client-side without the model when obvious:
  "suivant", "pause", "reprends", "plus fort", "moins fort", "c'est quoi ce
  morceau" → direct player/now-playing calls.
- Mic permission requested only on first press; no always-on listening.

## 9. Proactive and polish

- On opening the Musica sub-tab: a short greeting built from now-playing + radar
  count (one model call max, cached for 10 min; no call when nothing changed).
- "C'est quoi ?" chip uses now-playing; Musica may add brief context about the
  artist **clearly marked as general knowledge** ("de mémoire, …"), never inventing
  catalog facts.
- Mood/activity requests ("un truc pour coder", "sport 45 min") map to Mixer
  config + discovery mix, with `why` lines.
- "Explique cette session" button in the Mixer preview sends the session summary
  (handles) to Musica.
- Update `docs/musica-persona.md` (new tools, handles, voice, radar) and
  `docs/musique-spotify.md` (confirmed Dev Mode limits, privacy policy, new files,
  new routes).

## 10. Definition of done

- All phases implemented or explicitly reported as blocked by a confirmed Spotify
  restriction (with the evidence).
- Unit tests green; new tests cover multi-round loop, handle resolution and URI
  rejection, privacy scrubbing, taste migration and ban rules, radar, voice route.
- Manual check in the running HQ (owner's machine; ask before restarting the
  bridge): "Musica, joue du Sabaton" plays in one turn; "joue la deuxième" works;
  album search and play works; radar shows new releases; voice round-trip works in
  Edge/Chrome; dark mode cards look right; phone width has no horizontal scroll.
- Final report: what shipped per phase, what was cut and why, Spotify endpoints
  confirmed working vs. unavailable, and any re-consent needed for new scopes.
