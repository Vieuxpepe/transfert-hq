# Atelier 3D — printers, cameras, models, MakerWorld (Elsea)

The `atelier3d` view (admin only) is run by **Elsea**, Else's daughter
(`hq_elsea.py`, chip `assets/hq-elsea-chip.js`). Back end: `hq_print3d.py`
(controller), `hq_print3d_bambu.py`, `hq_print3d_flashforge.py`,
`hq_print3d_models.py`, `hq_makerworld.py`. Routes: [hq-api-route-index.md](hq-api-route-index.md).

## Where things live

| What | Where |
|------|-------|
| Printers + access/check codes, MakerWorld cookie / UA / handle, extra model folder | `.hq-agent-state/print3d.json` (gitignored, never returned by an API) |
| Job history, model metadata, MakerWorld snapshots, Elsea's thread / growth / self | `.hq-print3d/` (gitignored) |
| Models | the `Print/` share (Fichiers uploads of `.stl/.3mf` land there) + one optional read-only folder |

## Printer setup

**Bambu Lab A1 / A1 mini (LAN).** On the printer: *Settings → LAN Only* on, then
*Developer Mode* on (current firmware refuses third-party MQTT otherwise). Note the
IP and the access code shown there, and the serial number (*Settings → Device*).
In Atelier 3D → Réglages, add the printer as *Bambu Lab (LAN)*. Status comes from
MQTT over TLS on port 8883 (`bblp` / access code); the camera is the TLS JPEG stream
on port 6000. The AMS Lite slots show up in the `ams` block.

**Flashforge Creator 5 (and AD5M / AD5X family).** On the printer: *Settings →
Network*, enable LAN mode; the serial number and the check code are shown there.
Status uses the HTTP API on port 8898 (`/detail`, `/control`); when that API is
absent the adapter falls back to the legacy G-code port 8899 (status only). The
camera is the MJPEG stream the printer advertises (`cameraStreamUrl`, usually
`http://<ip>:8080/?action=stream`). *The Creator 5 endpoints were written from the
AD5M protocol and have not been checked against the real printer yet.*

Only private IPv4 addresses are accepted, and links only ever connect to the IP in
the config. Bambu printers use self-signed certificates, so TLS is unverified there:
the pinned private IP is the only defence.

## Commands

Start / pause / resume / stop / light have **no HTTP route**. Elsea can only queue a card;
`POST /api/elsea/confirm` runs it once after the Master taps *Confirmer*.

**Starting a print** (`printer_start`, `Controller.plan_print` → `start_print`). The plan is
checked when the card is made and again at confirm: printer online and idle/finished/failed,
file sliced for that printer family, plate present, filaments loaded.

- *Bambu*: only a sliced 3MF (`Metadata/plate_N.gcode`). `slice_info.config` gives the target
  printer, time, weight and filaments; each filament is matched to an AMS slot by type and colour
  (then type), else the card is refused (`filament_mismatch`). Upload: implicit FTPS on 990
  (`bblp` / access code, data channel reuses the TLS session) to the storage root, then MQTT
  `project_file` with `url: file:///sdcard/<name>`, bed levelling on, timelapse off.
- *Flashforge*: `.gcode`, `.gx` or a sliced 3MF, sent with `POST /uploadGcode` and `printNow: true`
  (levelling on, no material station mapping).
- *Neither path has been tried on the real printers yet.* On a Bambu, if the job does not start,
  the storage URL (`file:///sdcard/` vs `ftp:///`) is the first suspect.

**Looking at the camera** (`camera_look`). One JPEG from the camera hub (≤1.5 MB) is attached as
an image to the next model round of that turn only — never stored in the thread. Only Gemini sees
it; the NVIDIA / local fallbacks skip image turns.

## Filament usage and cost (`hq_print3d_filament.py`)

Every print that actually ran is written to `.hq-print3d/history.json` with a `filament` block
(grams, metres, by material, and `source`). Where the figure comes from, best first:

| `source` | Meaning | Quality |
|----------|---------|---------|
| `slice` | the sliced file's own `used_g` / `used_m` per filament (`Metadata/slice_info.config`) — from the Print library, else the 3MF the Bambu **kept on its own storage** (`<job>.gcode.3mf`, fetched over FTPS) | exact for the plan; real use differs by purge/waste |
| `printer` | Flashforge `estimatedRight/LeftWeight/Len` while it prints (length unit auto-detected) | good |
| `ams` | drop of the AMS spool % between start and end × the spool size in the price settings | coarse (1 % of 1 kg = 10 g) |
| `counter` | the Flashforge `cumulativeFilament` counter's change over the job, **taken as metres** and converted to grams for the job's material. Last resort (the Creator 5's own estimate fields stay 0 even mid-print). The unit is undocumented: it moves live with extrusion and ~1.2 after two layers of a large flat part fits metres, but weigh one print and use *Corriger* to confirm. A reset counter (negative or >5 km change) is ignored | rough, to confirm |
| `manual` | typed in the Filament tab (*Corriger*), e.g. after weighing the part | real |

A stopped or failed print is the full estimate × the progress it reached; a print that ran to
≥97 % counts as finished. A print stopped while still heating is not recorded.
**Cost is never stored**: it is computed from the price table (*Filament → Prix du filament*,
`$ / kg` per material, a default, the currency and the spool size) every time the stats are
read, so changing a price re-prices the whole history. Materials map by base name
(`PLA-S` → `PLA`). Jobs that ran before this existed, or that no source could size, show
"sans chiffre" and are left out of the totals. The Elsea tools `filament_stats` and
`print_history` read the same numbers.

## Plain-language errors (`hq_print3d_errors.py`)

Each printer's `status.problems` lists what it is complaining about: `{code, text, severity, known}`.
Shown in red/amber on the printer card, kept on a failed or stopped job in the history (with *why*),
passed to Elsea (who explains them), and the chip whispers a serious one.

- **Bambu**: the printer sends `hms` entries (`attr`+`code`) and a `print_error`. Bambu publishes the English
  descriptions as one JSON file (`https://e.bambulab.com/query.php?lang=en`, ~330 KB, ~2 400 usable entries).
  HQ downloads it **only when a printer actually reports a problem and no copy under 30 days old is cached**
  (background thread, at most once an hour, https + that host only, redirects off-site refused, ≤4 MB, must
  parse and be complete), and keeps `ecode → text` in `.hq-print3d/bambu_errors.json`. Nothing about you is
  sent. Severity is the top half of the HMS `code` (1 fatal, 2 serious, 3 common, 4 info).
- A code the catalog lacks still shows its code grouped like Bambu's wiki (`0500-0200-0003-0012`) with a line
  saying so (`known: false`).
- **Flashforge** only exposes an opaque `errorCode`; there is no public table, so it shows the code and
  points to the printer's screen.

## Failure watcher (`hq_print3d_watch.py`) — off by default

Réglages → *Surveillance des impressions*. While a printer is **printing**, one camera frame (plus the
first clean frame of the job for comparison) goes to the vision model every `interval_sec` (120–900,
default 180) with a narrow question → `ok` / `suspect` / `failure`. No look during the first 4 minutes,
below 2 % or above 98 %, while paused or preparing; at most 300 looks a day (the Google quota is shared
with the chat). Frames are never stored.

- One odd verdict only schedules a second look 45 s later. **Two non-ok in a row** raise the alarm
  (`suspect` if none was a `failure`, else `failure`); an `ok` resets the streak.
- An alarm shows on the printer card (`status.watch.alarm`), Elsea whispers it from the chip and explains it,
  and a Web Push is sent when push is enabled.
- **`auto_pause` (separate switch, off by default)**: after a confirmed `failure` only, HQ sends `pause`
  to the printer — never `stop`, at most once per job. A Resume clears the alarm and no further automatic
  pause happens for that job. This is the one place a printer command runs without a confirm card.
- Model order: Gemma 26B, Gemma 31B, then Gemini Flash-Lite only if both are busy; the model that answered is in `status.watch.model`.
- A model error backs off 10 min; an unreadable answer counts as `ok`. It is a general vision model, not a
  trained spaghetti detector: expect misses and false alarms.

## Cameras

`GET /api/print3d/camera/<id>` re-wraps the printer's frames as MJPEG for an
`<img>`. One upstream per printer, opened on demand and closed ~15 s after the
last viewer; at most 4 viewers; **a printer's camera accepts one client at a time**, so a camera view held open in Flash Studio, Bambu Studio / Handy or a phone app locks HQ out (HQ then says so, and Elsea's `camera_look` reports it); the session is re-checked every second and a stream
ends after 30 min. The tab closes streams when it is hidden.

## MakerWorld

- Per-design stats come from `/api/v1/design-service/published/<uid>/design`, which
  Cloudflare does not challenge. It needs the numeric uid (the number in the
  avatar URL); it is learnt automatically the first time the profile page loads.
- Followers, boosts and points come from the profile page `/en/@<handle>`
  (`__NEXT_DATA__`), which Cloudflare challenges for plain clients. Paste the
  `Cookie` header from a logged-in browser and that browser's User-Agent
  (`cf_clearance` is bound to it). When it is challenged anyway, the design totals
  are still refreshed and `last_error.code` is `makerworld_blocked`.
- **Linking models to designs**: a model's `makerworld_design_id` (set in its editor) shows its design's
  downloads / prints / likes / comments and the 7-day change on the card, in the detail view and to Elsea
  (`mw` field). *Retrouver sur MakerWorld* suggests designs by title similarity (`GET /api/print3d/models/match?id=`);
  it only fills the field, you still press *Enregistrer*.
- **Alerts** (Réglages → *Alertes MakerWorld*, on by default, phone push off): at each refresh a design
  that gained at least `min_jump` downloads or prints against the snapshot 12-48 h old (nearest a day) **and**
  `ratio_pct` % of that day's total raises a *spike*; a rise of a design's comment count since the previous
  refresh raises a *comments* alert (the count only: the comment text is not read). Stored in
  `.hq-print3d/makerworld.json` (`alerts`, last 40, de-duplicated by id), listed in the MakerWorld tab, whispered by
  Elsea's chip. They appear at refresh time, so up to 6 h late. Nothing is compared on the very first snapshot.
- Refresh: every 6 h from the bridge background tick, or the *Actualiser* button
  (at most once a minute). History keeps 400 snapshots for the charts and 7-day deltas.

## Freshness, cache and paging

- **Polling** (`assets/hq-print3d.js`): one `/state` request at a time; a reply that lands after a tab
  switch or a newer request is dropped. 4 s while a job prints, 10 s at rest, **none** on another tab or
  on a hidden page; two failures in a row back off 5 / 15 / 30 s. The printers card updates in place: a
  poll never rebuilds the camera `<img>`, the alert list or the history list.
- **`/state` is conditional**: the body carries `etag`, the next poll sends it as `If-None-Match`, and an
  unchanged overview answers `304` with no body. If the shell's `api()` cannot surface a 304, the view
  retries once without the header and stops asking for the rest of the session.
- **History is parsed once per file version**: `history.json` is cached on `(mtime, size)` like the config,
  so a warm poll reads no file, and every write drops the cache. It is capped at `MAX_HISTORY` rows.
- **`link.at` is the last attempt, `link.since` the start of the outage**: the link retries every 3-60 s while
  offline, so only `since` can say *depuis* how long; the card shows it.
- **Models are paged**: `GET /api/print3d/models?limit=&offset=`; the grid offers *Afficher plus* while
  `total` exceeds what it holds, and reuses the tiles it already has instead of rebuilding them.
- **Uploads** send `chunk`-sized pieces, retry one transport failure or 502/503/504, and can be cancelled
  from the bar (`AbortController`). A 4xx/507 keeps its reason on screen instead of a toast.
- **Cameras**: the card asks for `?fps=5`; the full-screen view sends no `fps` and takes every frame. `fps`
  only caps how often a viewer is written to (0/absent = every frame, clamped 0-30; `q=low` still means 2);
  the JPEGs are forwarded untouched — HQ has no encoder, so resolution and quality are the printer's.

## Verify

```bash
python -m unittest tests.test_hq_elsea tests.test_hq_print3d tests.test_hq_print3d_http \
  tests.test_hq_print3d_filament tests.test_hq_print3d_errors tests.test_hq_makerworld_alerts -v
node tests/check_hq_print3d.mjs
```
