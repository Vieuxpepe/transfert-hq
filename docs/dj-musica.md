# DJ Musica — show engine, surfaces and identity

Read this before touching the DJ feature. Routes are documented one by one in
`hq-api-route-index.md` (search for `api/musica/dj`); this page explains how they fit together and which
client surfaces must stay in sync.

## Layout

| Piece | Where |
| --- | --- |
| Show engine (planning, drops, observe, steering, duels, tournament, station) | `hq_music_dj.py` + `hq_music_dj_{station,live,talk,dig,facts,hall,archive,export,tournament}.py`, `hq_music_station.py` |
| DJ speech from `/api/musica/dj` | `hq_musica.dj_line`, persona and speech trace in `hq_musica.py` |
| Page, on-air strip, quiet dock, chat, tournament UI | `assets/hq-music.js`, `hq-music.css` |
| Chip bubbles and concealment | `assets/hq-musica-chip.js` |
| Song identity shared by every surface | `assets/hq-now-playing.js` |
| Accueil station card / moments | `assets/hq-home-cards.js`, `assets/hq-musica-moments.js` |
| State | `.hq-music/dj_state.json`, `dj.json` (settings), `musica_speech.json`, `musica_song_titles.json` |

## Lifecycle

```
idle --POST /dj/start (202)--> prep: pools -> writing -> voice -> play -> done
     --> awaiting (intro drops in state.awaiting)
     --POST /dj/go {segment_id}--> on air (state.segment)
     -- each track change: POST /dj/observe {uri, previous_uri, previous_ms}
        -> drops + text (intro, track line, live reaction)
     -- last track of a segment -> state.next is promoted, next segment planned ahead
     -- stop / next / closing segment --> active:false, last_ended_at
```

- Preparation never runs inside the request: the browser polls `/api/musica/dj/state` (`prep.stage`,
  `pct`, `label`) and `/dj/prep/cancel` stops at the next checkpoint.
- A blind duel hides the song (`state.duel.blind && !vote`); tournament and quiz reuse that flag.
- The PC station (`hq_music_station.py`) is a separate player path: observe answers are ignored while it
  runs, and the station resumes on bridge boot.

## What "now playing" means here

One module decides the song: `assets/hq-now-playing.js`. The DJ page must not rebuild it from
`item.name` / `playing`:

- `nowPlayingOf()` in `hq-music.js` calls `Song.identity({view:"musique", playback:{...}})` then
  `Song.remember()`, and stores `state.nowPlaying`.
- The DJ announce posts `track`/`artist` from that identity plus `key` and `source`; `dj_line` logs the
  spoken line to `/api/musica/speech` (`kind: "dj"`) so a wrong-song report is one request.
- A generated line goes through `Song.filterLines([line], song.title)` before it is shown or spoken: a
  line naming another track is dropped, like on the chip.
- Tournament lines are about the duel's own tracks, not the playing song; they are not filtered by title.

### Blind matches

`GET /api/musica/conceal` returns `{concealed}` from `state.duel`; the chip polls it (and
`refreshConceal(true)` on becoming visible), and `hq-music.js` also sets the local reason from the quiz.
`HqNowPlaying.isConcealed()` is the OR of both, so a scheduled duel hides the song even if the Musique
page was never opened. Server prompts (`dance_prompt_context`, `ambient_now_playing`, dance pack) refuse
to name a song while blind; cached client packs must respect the same flag.

### Local playback

The Lecteur audio publishes `hq:local-play {playing}`. `hq-music.js` posts
`/api/musica/dj/local` and the show steps aside (`left: true`, status « DJ Musica s’efface : tu as lancé
autre chose. ») exactly as for a foreign Spotify track. Local playback also suppresses DJ announces on
the next Spotify poll. Stopping the file does not resume the show.

## Tests

- `python -m unittest tests.test_hq_music_dj tests.test_hq_music_dj_duel tests.test_hq_music_dj_tournament tests.test_hq_music_station -v`
- `python -m unittest tests.test_hq_music_salon -v` — `dj_line` model call, cooldown, speech-trace row.
- `python -m unittest tests.test_hq_musica -v` — prompt honesty, conceal route, title overrides.
- `python tests/visual_dj_page_playwright.py` — browser smoke on the throwaway HQ with stubbed
  Spotify/DJ APIs: on-air identity, concealment without the Musique page, local step-aside.
- `node tests/check_song_identity.mjs` — static wiring of the shared identity on both pages.

## Agent notes

- Never start a real show or touch Spotify/the owner's station in a test; stub the APIs
  (`tests/visual_dj_page_playwright.py` shows the pattern) or mock `hq_ai` in unit tests.
- Starting a show returns 202 by design; do not treat a missing `segment` in that response as a failure.
- Admin session and CSRF are mandatory for every DJ route; audio routes require admin too.
- Keep the standard-library architecture: DJ state goes through `hq_music` (`music._load/_write`) and
  `hq_state`, never ad-hoc file writes.
