# Pistonia chip (Engine tab assistant)

Pistonia is the chief mechanic of the Engine room. She only appears on the **Engine** tab, for an admin session
(`assets/hq-pistonia-chip.js`, `assets/hq-pistonia.css`, backend `hq_pistonia.py`).

## The chip
* On a phone (≤ 520 px) the chat is **full screen** instead of a floating window: no corner grip, nothing to place, the page behind stops
  scrolling and the whole chip sits above HQ's debug overlay. Wider screens keep the draggable, resizable window. While the on-screen keyboard is up, the chat is fitted to
  `window.visualViewport` (height and offset), so the composer stays above the keyboard and the thread keeps its bottom. The quick replies fold away while the keyboard is up (the `is-keyboard` class), which gives
  the thread their height back; they return when the keyboard does.
  A downward **swipe from the header** closes it (past ~90 px, or a quick flick); the page behind dims up to 45 % as it goes, so
  the drag reads as a dismissal; a shorter one **springs back with an overshoot that follows the release speed** — ~6 px for a slow let-go, up to ~20 px for a
  quick one, 340–460 ms (Web Animations; straight home under `prefers-reduced-motion`), and a press that
  starts on one of the header's buttons is never a swipe. The same gesture works on the desktop window — a downward drag
  dismisses instead of moving — while any other direction still moves the window; on a phone the header drags nothing.
* **Drag** it anywhere (mouse, finger, or Shift/Alt + arrow keys when focused). It is clamped to the screen and the position is saved as
  a fraction of the screen (`hq_pistonia_chip_pos_v1`), so it survives another screen size. Dragging the chat header moves it too.
* **Resize the chip**: pinch, Ctrl + wheel, or the menu (shared `hq-image-chip-scale.js`, saved in `hq_pistonia_chip_scale_v1`).
* **Resize the chat window**: drag the grip in the corner farthest from the chip (it flips with the window's placement), or focus the grip
  and use the arrow keys (Shift = bigger steps). Saved in `hq_pistonia_bubble_size_v1`; limits 300x300 to 760x860 and always inside the screen.
* Right-click or long-press the chip for the menu: smaller / larger / normal size, normal window, original position, hide
  (the Engine tab has a "Pistonia" button to bring her back).
* The dot on the chip follows the Engine tab's live status: green = steady, amber (pulsing) = busy, red (pulsing) = something needs a look
  (a daemon in error/foreign/warn, RAM or VRAM at 90 % or more), blue = she just answered.

## Portraits: SFW now, your image later
Same convention as Else and Inventoria (`hqCompanionNsfwOn()`, event `hq:companion-nsfw`, `HqImageChipScale.bindPortraitMode`).

| Mode | File | Status |
|---|---|---|
| SFW (adult mode off) | `assets/companion/pistonia-chip-sfw.webp` (640 px) + `pistonia-chip-sfw@2x.webp` (1280 px) | done: amber squircle, gear with a piston, spark gem. Source `pistonia-chip-icon.svg`; regenerate with `python scripts/gen_pistonia_chip_icons.py` |
| Adult mode on | `assets/companion/pistonia-chip.webp` (+ optional `pistonia-chip@2x.webp`) | **drop your image here**; nothing else to change |

When adult mode is on the chip checks once whether `pistonia-chip.webp` exists: if it does, it is used for the chip and the chat header
(CSS class `is-adult-portrait` on `#hq-pistonia`); if it does not, the SFW icon stays, silently. A square image works best (the chip is
rounded to 24 %); 640 px for 1x and 1280 px for @2x, like the other chips. The conversation itself (persona, tools) is the same in both modes
for now; a more adult persona would be a separate prompt, which I'd add together with the image if you want one.

## Character, memory, alerts, voice
Her character, memory, proactive alerts and voice are described in [../pistonia-persona.md](../pistonia-persona.md). In the chip:
* The conversation is **server-side** (it survives a reload and other devices); the chip restores it on open. The ⚙ button opens settings:
  notifications toggle, her notes with delete buttons, *Effacer la conversation*.
* A **red badge** on the chip counts alerts she raised that you have not seen; the chip rings until you open it. With the chat open, new alerts and
  all-clears appear live.
* While she works, her row says what she is actually at ("Je lis le journal de Coqui XTTS…") **and prints the steps she has already
  been through above it**, polled from `GET .../progress?job=` (`stage`, `found`, and `steps`, each step being `{say, found}`).
  A step says what it found, not only what it read — "Je lis le journal de Forge… — 20 lignes", the count in `--pis-info` — because
  `found` is the tool's short result (`0 moteurs`, `échec`, `note gardée`), deliberately not the stored trace label, which would
  repeat the step. Each new step appears once, with a dot and a
  short rise (`MOTION.step`, 220 ms); lines already printed are never rebuilt, so nothing flickers between polls. The server keeps the
  last eight steps and the list drops from the head as that window slides — one line leaves, one arrives. The current line hands over
  to the next instead of swapping: the outgoing label stays in the same grid cell, fading out while the new one fades in
  (`MOTION.stage`, 240 ms), so the wait reads as one thought continuing. Both effects are skipped under `prefers-reduced-motion`,
  which swaps the text instantly. When the answer lands, those steps **fold into one closed line under the reply** —
  `Parcours · 3 étapes`, a native `<details>` so it is keyboard- and screen-reader-reachable — and opening it replays the path with
  what each step found. A turn with a single step gets no fold: there is no path to reopen. Nothing is stored for it; it is the
  wait's own history, kept in the page rather than in the thread. **Arrêter** now really stops her: the chip posts
  `POST .../cancel {job}`, the server drops the turn at its next model round or tool call and stores nothing, so a dismissed answer never
  turns up later in the thread. (An answer already written when the cancel lands is the one exception; it shows like any other reply.)
* Typing while she thinks **queues** the message instead of dropping it: an « En attente » row with a ✕ sits in the thread, and it is sent —
  or removed — when the reply lands. Three can queue; beyond that the text stays in the box, untouched.
* The **quick replies follow the engine**: a daemon in error/foreign/warn, VRAM or RAM above 80 %, a busy engine each bring their own chip
  ("Que faire pour Coqui XTTS ?"), completed to four with the standing ones. They are rebuilt from the live status, and never under your
  finger while the state is unchanged.
* Messages carry their time: a day pill ("Hier · 21:14") at a new day, and the hour after a ten-minute pause. Her greeting is a quiet italic line, not
  a reply bubble.
* On the server, the model sees **her own last answer whole** (only older turns are clipped to 700 characters) plus a one-line digest of the
  conversation older than those 12 turns, so "the third error line" still has a referent in a long session (`DIGEST_TURNS`).
* The 🔊 button turns her voice on or off (Phonon, English, read aloud when the chat is open).

## What she can do
She sees the live Engine state (this PC, every daemon, paired computers, logs, recent actions) and answers from it. She can **propose** a
start / stop / restart or turn idle auto-stop on or off, shown as a card with the effect ("Frees about 374 MB of RAM. The next voice line uses
the browser voice while it reloads") and an **Appliquer** button, plus **Pourquoi ?** which sends her "Pourquoi ?" with that card quoted back as context
(a `context` field on the message POST, folded into the model's view of that one turn only — never stored, so the thread keeps
the Master's own words). Her **alerts and all-clears** carry the same re-ask, quoting that line as `Alerte de Pistonia : …` or
`Retour à la normale : …`.
* **One motion table.** Every motion in the chip — the pull's rebound, the opening pop, the resize settle, the jump
  pill, the hover lift and drag grip, the busy/alert dot pulse and the unread-alert ring — is tuned in the `MOTION` object at the top of `hq-pistonia-chip.js`: one curve (`ease`), one overshoot point
  (`peak`, the 50 % keyframe) and per-motion duration formulas. The chip writes the curve and durations into CSS custom
  properties (`--pis-spring`, `--pis-bounce`, `--pis-pop-ms`, `--pis-pop-scale`, `--pis-pill-ms`, `--pis-chip-ms`,
  `--pis-hover-scale`, `--pis-drag-scale`, `--pis-dot-ms`, `--pis-dot-alert-ms`, `--pis-dot-scale`, `--pis-ring-ms`)
  on `.hq-pistonia`, so the stylesheet's keyframes and transitions read the table instead of repeating its numbers.
  Two curves live there: `ease` for the keyframe springs, whose overshoot is authored as a keyframe, and `bounce` for
  the chip's transitions, which have no keyframe and so must carry their overshoot in the curve itself.
* Opening the chat and resizing the window settle the bubble on the same spring as the pull: the opening pop plays
  `0.92 → 1.012 → 1` over 340 ms, and a debounced window resize gives a 1.2 % scale settle (240 ms) instead of a jump.
  Both are skipped under `prefers-reduced-motion`.
* **She says it, she doesn't dump it.** The answer is streamed: `POST .../stream` answers `text/event-stream` (chunked), the bridge
  writes one `delta` frame per model fragment, and the reply row grows word by word with a caret at its end (`--pis-caret-ms`).
  The fragments are the raw model text — a `{"reply": ...}` document — so the server decodes the string as it is written (`_ReplyTap`,
  which survives a `\uXXXX` or a lone backslash split across two frames) and sends the text so far; `reset` retracts text from a round
  that turned out to be a tool call or from an attempt that died mid-way, and `done` carries the stored message exactly as `.../message`
  would have. The old path is still there and is the fallback: if the bridge has no such route, the browser cannot read a stream, or
  nothing streams, the chip posts `.../message` and **the typewriter** reveals the reply at ~1200 characters a second with the trace,
  chips and cards following behind it — the same spoken feel, one step less honest. Both are skipped under `prefers-reduced-motion`,
  which shows text as it lands. The chunk reader itself lives in `assets/hq-pistonia-stream.js` (a whole event can arrive spread
  over many reads, or several in one), pinned by `tests/check_hq_pistonia_stream.mjs`, which splits a body at every byte and expects
  the same events back; if that file is missing the chip posts `.../message` rather than hanging on a stream it cannot parse.
* **Her voice is visible.** An `AnalyserNode` on the very element that plays her WAV drives `--pis-level` (0..1), and the dot's glow and
  the portrait's scale follow it — she visibly talks. The audio context is opened on the first gesture (a context created outside one only
  warns and stays silent), and everything degrades to stillness when WebAudio is unavailable.
* **A sparkline in the header** (40×14 canvas, 30 polls) traces RAM and VRAM from the `hq:engine-status` events beside her name, so
  "RAM is at 91 %" has a shape you can watch. Hovering (or tabbing to) it shows the exact RAM and VRAM percentages of the last poll,
  any value at 90 % or more in the warning colour — the shape for the glance, the numbers when you mean it.
  When a pool stays at 90 % or more for three polls running, the readout says so ("RAM saturée depuis 3 relevés") and the
  sparkline glows in the warning colour even while the readout is closed; one poll back below 90 % clears it. A single spike never does.
  The claim also expires when nothing renews it — it asserted something about *now*, and the numbers beside it stay as the last thing
  seen, not as a current reading. The deadline follows the cadence the Engine tab actually keeps rather than a constant: the chip
  times the gaps between `hq:engine-status` events (4 s idle, 1.5 s while a daemon moves), so silence is judged as six missed polls,
  bounded between 30 s and 3 min, with a 90 s fallback until two polls have shown it the rhythm.
  Past that same deadline the whole sparkline goes grey and dim (`is-stale`, 34 % opacity, no colour), so an old trace can never pass
  for a live one; the next poll brings the colour straight back, and the readout's accessible name says "relevé ancien" while it lasts.
* **Loose ends land, not appear**: proposal cards spring in (`MOTION.card`), an applied card's border flashes `--pis-ok` once, its Apply
  button becomes a ✓ and the Undo slides in behind it; the current stage line carries a slow light sweep (`hq-pis-scan`) instead of a spinner;
  and the portrait tips its head when the chat opens (`MOTION.tip`). All of it is skipped under `prefers-reduced-motion`.
* Every reply carries **Ce qu'elle a lu (n)**: a folded list of the tool calls behind it ("Journal de Forge — 20 lignes"), so a claim about the
  machines can be checked before acting on it. Only the short labels are stored with the message (`trace`), never the tool payloads, so they
  survive a reload. A **Copier** link sits next to it, and follow-up chips ("Les dernières lignes", "Plus court", "Pourquoi ?") belong to *that*
  answer instead of to the engine status; using one keeps the answer as the subject of the next turn.
* Applying a card leaves an **Annuler — Démarrer/Arrêter <daemon>** button (the inverse action, through the same allow-listed route), so a quick
  Apply is not a one-way door; a restart offers no undo. "Pourquoi ?" still quotes the original card.
* Scrolled up when something arrives, a **Nouveaux messages** line marks where the unread part begins, and it goes away when he jumps home.
  Retry after an error removes exactly the question it re-sends, never "whatever is last in the thread".
* The thread follows the newest message only while it is at the bottom: scroll up and new lines are counted instead of
  dragging the view (the same in the phone sheet and in the desktop window). A **Dernier message ↓** pill ("3 nouveaux messages ↓" once she has said some) floats over the tail of the
  thread and springs in, and the entrance follows the speed that uncovered it: a slow drag gives an 8 px rise with
  ~1.5 px of overshoot, a hard flick a 20 px rise with ~9 px past home and a matching scale bump (220–420 ms).
  Under `prefers-reduced-motion` it is a plain fade, and its scroll velocity is never inherited from a jump home so
  it never reflows the conversation; sending anything jumps to the bottom regardless.
  The quoted line then stays the **subject of the Master's next question**: a typed follow-up ("et combien ça libère ?") carries
  the same context without quoting the card again, and is consumed after that single turn so a change of topic is not haunted by it. The button calls the normal admin + CSRF Engine endpoint; the chip only
ever calls `/api/engine/daemons/<id>/<start|stop|restart|autostop>` (allow-list in the script), whatever the server sends. The only thing she can
write herself is her short memory notes.

API (all under `/api/engine/pistonia/`): `GET thread`, `GET greeting`, `GET progress?job=` (the live stage and its `steps`, empty once she is
done), `POST message {text, job?, context?}` (32 KB body limit; the reply carries `trace` and `cancelled`), `POST stream` (the same body,
answered `text/event-stream` with `delta` / `reset` / `done` / `error` frames; the route lives in `iphone_bridge.py` because only the
handler can write a chunked body), `cancel {job}`, `clear`, `seen`,
`resolve {id}`, `memory/delete {id}`, `settings {notify?, voice?}`, `voice {text}`.
