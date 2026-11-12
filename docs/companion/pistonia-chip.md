# Pistonia chip (Engine tab assistant)

Pistonia is the chief mechanic of the Engine room. She only appears on the **Engine** tab, for an admin session
(`assets/hq-pistonia-chip.js`, `assets/hq-pistonia.css`, backend `hq_pistonia.py`).

## The chip
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

## What she can do
She sees the live Engine state (this PC, every daemon, paired computers, logs, recent actions) and answers from it. She can **propose** a
start / stop / restart or turn idle auto-stop on or off, shown as a card with the effect ("Frees about 374 MB of RAM. The next voice line uses
the browser voice while it reloads") and an **Appliquer** button. The button calls the normal admin + CSRF Engine endpoint; the chip only
ever calls `/api/engine/daemons/<id>/<start|stop|restart|autostop>` (allow-list in the script), whatever the server sends.

Safety, each with a test (`tests/test_hq_pistonia.py`): no tool changes anything; proposals are validated when made (known daemon, action
allowed, sensible for its state; foreign and observe-only daemons refused); logs are scrubbed and framed to the model as data, not
instructions; a reply that claims "I stopped X" with no proposal is sent back once, then neutralised; bounded to 4 model rounds, 8 tool calls,
4 proposals, 12 history turns, 12 messages per minute; provider error text is never shown (friendly "model busy" + Retry).

API: `GET /api/engine/pistonia/greeting` (no model call), `POST /api/engine/pistonia/message` `{text, history}` (32 KB body limit).
She replies in the language you write in. Persona and tool protocol: `PERSONA` / `TOOLS_DOC` in `hq_pistonia.py`.
