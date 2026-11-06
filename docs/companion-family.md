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

The relationship is part of her full and compact character guidance in
`hq_companion_presence.py`. It does not copy Else's private history or merge their
memories. Shared sister dialogue (Master-triggered, ambient banter, or rare react)
is owned by `hq_sister.py`, stored under `.hq-ai/sister_dialogue/`, and may leave a
light episode note in each sister's own memory file. Prompt cross-awareness uses a
read-only `sister_awareness_block` (last log lines) — never a merged memory store.
Else stays image-only (chip + bubble); Transferania keeps Live2D. Client stage
director: `assets/hq-sister.js` (`window.HqSister`) queues exchange/ambient/react,
syncs prefs from `status().sister`, and owns the bus. Events: `hq-sister-line`,
`hq-sister-open`, `hq-sister-peek`, `hq-sister-event`, `hq-sister-nudge`,
`hq-transferania-line`, `hq-else-line`, `hq-sister-busy`, `hq-sister-prefs`,
`hq-sister-history`. Ambient banter peeks the chip (no forced bubble open);
Master-triggered Sœurs still opens Else. Interactivity: Master `↔` nudge
(soft glance, 2× escalates to 1-turn banter), click a sister-strip line to
prompt the other, bidirectional Master-chat reacts (T→Else and Else→T), and
occasional pass-ball after ambient/event. Naturalness: asymmetric ambient
turns, view/hour situation seeds, sticky `open_thread` (~45 min), named
random sister events (~half of free ambients — compete/care/tease/observe/
invite, no open-fil interrupt, recent-id cooldown), Else sometimes asides to
the Master, attention gates (no banter mid-chat / NSFW expanded), per-sister
line caps, and glance micro-reactions without a model call. Prefs:
`sister_ambient_enabled`, `sister_react_enabled`. Status exposes `else` +
`sister` (incl. `open_thread`, `last_event_id`). Canon sync:
`C:\Gemini-Test\scripts\sync_family_canon_docs.py`.

## Else HQ ↔ Gemini-Test handoff

Else on HQ uses the Project G **persona capsule** (`hq_else_persona.py`) — identity
and voice only, no Gemini daemons. She can also be lightly proactive (`op: ambient`
on the Else action): rare measured asides that peek the chip without opening the
bubble, mostly soft lines, sometimes ambient-budget model text, with a ~12 min
cooldown and a client **Pro.** toggle. After a real Else chip chat, HQ may refresh
`C:\Gemini-Test\ELSE_TRANSFERT_HANDOFF.json` (evidence bullets). Gemini boot
(`else_agent_boot.py` / `else_transfert_bridge.py`) ingests that digest into
conversation memory once per hash. Manual: `python scripts/export_else_handoff.py`
(`--dry-run` builds without writing). Stores stay partitioned; test/temp HQ roots
do not auto-export; handoff files are never written into the Transfert tree.
