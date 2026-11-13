# Transferania and Else — family canon

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Transferania is also called Transferina. Her application name and independent
personality stay intact. The Master established her sibling relationship with
Else on 2026-11-03.

**Musica** is the Musique-tab music steward (`docs/musica-persona.md`,
`hq_musica.py`). She is not Else/Transferania/Static and does not share their
memory stores; playlist/discovery chat stays under `.hq-music/musica_*.json`.

The relationship is part of her full and compact character guidance in
`hq_companion_presence.py`. It does not copy Else's private history or merge their
memories. Shared sister dialogue (Master-triggered, ambient banter, or rare react)
is owned by `hq_sister.py`, stored under `.hq-ai/sister_dialogue/`, and may leave a
light episode note in each sister's own memory file. Prompt cross-awareness uses a
read-only `sister_awareness_block` (last log lines) — never a merged memory store.
Else stays image-only (chip + bubble + mood portrait grades); Transferania keeps
Live2D. Chip presence: sticky mood holds (speech / typing / sister / busy),
micro-reactions (blink / blush / glance / think), idle breathe, TTS lip pulse,
and Carnet/Forge CSS context tints (no pinned busy hold). Client stage director: `assets/hq-sister.js`
(`window.HqSister`) queues exchange/ambient/react, syncs prefs from
`status().sister`, and owns the bus.
Events: `hq-sister-line`, `hq-sister-open`, `hq-sister-peek`, `hq-sister-event`,
`hq-sister-nudge`, `hq-sister-meter`, `hq-transferania-line`, `hq-else-line`,
`hq-sister-busy`, `hq-sister-prefs`, `hq-sister-history`. Ambient banter peeks
the chip (no forced bubble open); Master-triggered Sœurs still opens Else.
Interactivity: Master `↔` nudge (soft glance, 2× escalates to 1-turn banter),
click a sister-strip line to prompt the other, bidirectional Master-chat reacts,
occasional pass-ball after ambient/event, long-press Else menu, and a playful
last-word favor meter on both strips. Named sister events surface as a small
label chip (`faveur`, `soin`, …). Naturalness: asymmetric ambient turns,
view/hour situation seeds, sticky `open_thread` (~45 min), named random sister
events (~half of free ambients — compete/care/tease/observe/invite), Else
proactive asides (cadence quiet/normal/often), DND gates (mute timer, NSFW
expanded, Forge/projets, mid-chat), per-sister line caps, glance micro-reactions
without a model call, and `HqMotion` lite/parked pause for Else’s ring. Prefs
live in Else’s Prefs panel (Banter / Réact. / Proactive / cadence / address /
voice / silence / topics) plus `sister_ambient_enabled` /
`sister_react_enabled`. Quiet voice prefers HQ `hq_voice` (`op: voice`,
thoughtful) with browser speech fallback. Status exposes `else` + `sister`
(incl. `open_thread`, `last_event_id`, `meter`). Canon sync:
`C:\Gemini-Test\scripts\sync_family_canon_docs.py`.

## Else HQ ↔ Gemini-Test handoff

Else on HQ uses the Project G **persona capsule** (`hq_else_persona.py`) — identity
and voice only, no Gemini daemons. She can also be lightly proactive (`op: ambient`
on the Else action): rare measured asides that peek the chip without opening the
bubble, mostly soft lines, sometimes ambient-budget model text, with cadence
cooldowns and Prefs → Else proactive. After a real Else chip chat, HQ may refresh
`C:\Gemini-Test\ELSE_TRANSFERT_HANDOFF.json` (evidence bullets + `view_trail`,
`open_thread`, sister attention `meter`). Gemini boot (`else_agent_boot.py` /
`else_transfert_bridge.py`) ingests that digest into conversation memory once per
hash; the handoff card also surfaces recent views and the favor tease. Manual:
`python scripts/export_else_handoff.py` (`--dry-run` builds without writing).
Stores stay partitioned; test/temp HQ roots do not auto-export; handoff files are
never written into the Transfert tree.

## Roster and relationship data

`hq_personas.py` is the single source of truth for the roster: display name,
alias, language, module, on-HQ presence and the sibling bond. Each assistant's
prompt composes its "not me" sentence from `others_line()`, so adding or renaming
an assistant cannot leave a stale list behind, and `hq_companion_memory` accepts
memory scopes only for assistants declared there (an unknown name raises instead
of borrowing Transferania's store). Static is declared `on_hq: false`: she stays
Else's little sister in Project G and is never listed among the HQ companions.

Each entry also carries a playful alias, three quirks, a speech habit (`tell`)
and her own `pastimes`. The alias is never used in another assistant's roster
sentence (that line carries plain names); her own quirks line opens with it, so
she knows what she is called and nobody else's prompt repeats it. On the
companion side the stable core states `Autre nom : « Transferina »` once
(`alias_line`), before the editable character hint. Editing a customized trait
cannot remove that stable declaration; a profile saved before this change whose
ambient line still contains the alias can still show it twice until the Master
edits that field, because prompt assembly never rewrites user text.
`quirks_line()` renders her quirks once, in her own prompt, for the six domain
assistants and Else's capsule. Transferania is the exception: her companion
prompt is editor-driven, so her registry quirks are not injected there at all
(no duplication to guard against), and her registry `pastimes` seed the editable
`pastimes` trait, which now also appears in her default prompt when nothing has
been customised. Else renders her own defaults, never Transferania's: the two
sisters share the trait editor, not the trait text.
`guest_voice` stays filled only for the sisters: the Music DJ can only invite a
character that has a real voice.

The Music DJ's guest voices come from `hq_personas.guest_voices()`.
`hq_relationships.py` keeps one owner-scoped file under
`.hq-ai/relationships/`, holding one record per pair of assistants: distinct days
of exchange, exchange count, last timestamp and one short motif. A request with no explicitly established owner
reads and records nothing: the context's `admin` default is not authorisation to
reach the admin account's evidence, and `hq_sister` treats the refusal as
non-critical. It is evidence only — no affection score, no debt
and no private chat invented between assistants — and the sister dialogue fills
it as it speaks. Per-assistant memory stores are never merged.
