# Companion memory and follow-through

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


Durable memories and follow-up topics are shared between PC and iPhone sessions
belonging to the same authenticated admin account. Conversation transcripts,
summaries, display settings and warmth remain device-specific. Other admin
accounts have separate profiles, thread files and preferences. The bridge passes
the authenticated session's user identity; a request body cannot choose an owner.
Upload-only sessions cannot access memory operations.

Transferania's profile lives under `.hq-ai/companion-memory/<owner-hash>.json`;
Else uses her own subfolder (`else/<owner-hash>.json`), and any other assistant
that opts into the shared companion store gets its own subfolder too. A scope
name that is not declared in `hq_personas` is refused rather than falling back to
Transferania's file. Most domain assistants keep their purpose-built stores
instead (`.hq-household` for Culinia, `.hq-forge` for Forgia, `.hq-inventoria`
for Inventoria, `.hq-engine/pistonia` for Pistonia); they do not read or write
the companion memory file. No new model calls
are made for memory extraction, retrieval, migration, correction or review.
Each request still uses the existing context builder and its budgets. At most
five relevant active memories are selected, ordered by relevance and recency.

## Character evolution

Transferania keeps her own identity, dry humour, curiosity, aesthetic tastes and
capacity for gentle disagreement. Her motives are precision, beauty and care;
familiarity makes her more specific, never more demanding. Her character guidance
fits the existing context budgets and respects customized personality fields.

Inspired by the reinforcement/decay in `C:\Gemini-Test\else_psyche_evolution.py`
and Else's continuity arbitration, development is derived from the existing
owner-scoped episodes rather than a second database or background model loop.
No Else biography, personal memories, relational scores or live state is copied.

Repeated interests and experiences on separate days can become natural callbacks
in relevant social conversation, without an explicit memory question. Repeating
the same statement in one sitting does not strengthen it. The provisional motif's
salience grows over at most five distinct days, fades with age, and expires after
the existing 90-day episode window. A later outcome still revises an earlier view.
These are evidence weights, not affection, mood or relationship-status scores.

Explicit statements such as “Our ritual is coffee before painting” or
“Notre rituel c'est le café avant la peinture” create a reviewable, optional shared
ritual. Questions, hypothetical/quoted rituals and assistant-only claims do not.
“Our ritual is no longer …” / “Notre rituel n'est plus …” retires the matching ritual.
The existing **Mémoire** panel shows its source and can remove it. All derived
development is recomputed from remaining sources; forgetting a source reverses
its contribution, including across devices and reloads.

Natural motifs share the existing single continuity slot, six-hour cooldown and
reservation rollback. A due follow-up takes precedence. Practical requests,
comfort and unresolved conversational repair suppress unsolicited callbacks;
unrelated topics do not retrieve them. Context selection still owns the budget,
and no extra provider calls, animation work or timers are introduced.

### Response nuance, delivery and expressions

Chat now assembles a small local response plan: curiosity, concentration,
reassurance, thoughtful attention, quiet pride (possibly cautious), or a light
challenge when invited. It describes Transferania's response, not the user's
unspoken emotions. Repair, comfort and concrete tasks take precedence. Optional
prompt guidance encourages specific imagery, dry humour and varied cadence based
on the previous delivered line; it adds no separate transcript or provider call.
Ambient keeps its smaller budget for true events and time context.

The response carries an allowlisted expression/voice plan. Existing speech
profiles handle delivery. The current portrait loop blends sub-degree head
orientation, a small nod and eyebrow offsets for seven seconds, fading in/out.
It adds no animation loop, runtime filter or per-frame root variables. Pulls,
dragging, explicit mouth gestures, manual eyebrows and reduced motion retain
priority; voice previews also retain ownership of audio.

Follow-up questions and explicit completion reports can include the user's own
related reason for caring about that topic. No reason is synthesized when none
was provided. Revised opinions expose their prior outcome and source alongside
the latest report, so a change can be explained rather than hidden.

### Character journal

**Mémoire → Journal de caractère** shows each current developing motif, when it
was updated, its distinct days of support, changes of opinion, and expandable
dated sources. Sources can be corrected or removed. Corrections require the
current shared revision, validate an explicit development statement, and keep
the original evidence day, so editing cannot manufacture reinforcement. Another
device's update yields a reload message; **Actualiser le journal** refreshes it.
The `episode_correct` memory operation accepts `id`, `text`, and `revision`.

### Own pastimes

A sixth editable trait, `pastimes` (Occupations et goûts), holds Transferania's own
hobbies. It is a character field, never a claim about the Master, and it is not
fed by the interest/ritual cards, which still come only from his explicit
statements. It shares the existing byte budget and revision guard.

### Occasional habits and input hygiene

Seven optional habits are selected locally from the current conversation:
briefly flustered after boldness, tiny celebrations, affection for a specific
provided detail, playful self-correction when asking for attention, an existing
shared ritual, tenderness toward imperfect things, and an occasional tell from
borrowing Else's technical vocabulary. No sample catchphrases are permanently
injected. At most one suggestion is offered, and only when the topic fits.
Tasks, distress, recall and unresolved repair suppress these suggestions.
Recognizable recent wording also suppresses the same suggestion. A ritual cue
requires an actual selected ritual source; it cannot manufacture a shared past.

The complete habit catalog is code-side, not seven extra paragraphs in every
request. The optional cue follows grounded context, and the existing whole-block
budget selector can omit it. Ambient's smaller prompt remains unchanged.
Delivery guidance contains cadence only: identity/intensity already belong in
the character core. Page signals retain their order under one shared context
heading, without repeating the heading for every signal.

The quirks-only hygiene checkpoint (before priority-based assembly) measured
the unchanged chat core at 5,848 UTF-8 bytes;
delivery guidance decreased from 390 to 141 bytes. With one habit selected,
delivery guidance was 294–317 bytes. The simple fixture's conservative input
estimate decreased from 6,314 to 6,065; ambient remained unchanged. These are
byte-based estimates, not tokenizer or provider-reported token counts. Provider
usage remains the existing source for actual billed input tokens. No extra
provider calls, memory stores, animation work or timers are added by the habits.

Tests:

```powershell
python -m unittest tests.test_hq_companion_character -q
node tests/check_hq_companion_character.mjs
python tests/visual_hq_companion_character_playwright.py
```

## Meaning and corrections

The local extractor recognizes explicit French/English preference statements,
project statements, names, temporary states, and “remember that” instructions.
It retains the complete statement, polarity, source device, source wording,
timestamps and evidence type. Questions, quotations, hypothetical statements,
and claims made only by the assistant are not harvested as user facts.

Corrections supersede an earlier active record for the same normalized subject.
Coffee/café and tea/thé have narrow aliases. General semantic equivalence is not
inferred: differently qualified subjects can coexist. Complex preferences can be
corrected directly in the review panel. Temporary mood/state records expire after
six hours. A previous mood must not be treated as the user's current state.

Legacy messages are imported lazily from the currently authenticated device;
other transcript files are never scanned. Up to 500 recent source messages are
examined on initial import. Legacy fact fragments without their original meaning
appear as “À préciser”; they are excluded from model context until corrected into
a complete explicit statement. An older device import cannot overwrite a newer
record. Removed/superseded keys have migration tombstones to prevent resurrection.

## Follow-through

Projects can create an `awaiting_outcome` topic, eligible after one day. A specific
assistant question tied to the user's topic can create `awaiting_user`. Generic
greetings/questions do not create persistent topics. Outcomes and relevant answers
resolve them; clear dismissal or the review panel can drop them. Greeting alone
does not clear a pending topic.

Only one due shared topic is offered per context, with a six-hour offer cooldown
across devices. Existing calendar/event follow-ups take precedence. A resolved
shared question is supplied as context for its answer, so a short answer on the
phone can refer to a question previously asked on the PC. These local rules are
conservative and do not claim general natural-language understanding.

The existing dated-event extraction also feeds shared event memories and a
follow-up eligible at 09:00 on the following day. Its validated date is labeled
as extracted evidence, retains the original user wording, and does not require an
additional model call. Event memory expires eight days after its date. Removing
a linked project/event memory also drops its pending follow-up.

## Review and storage

Use **Mémoire** in the companion bubble to inspect shared statements, correct or
remove a memory, and stop a follow-up. These are local API operations with no model
usage. **Effacer** clears only the current device's conversation; its confirmation
explains that shared memories remain. Removing a shared memory does not erase its
source text from saved conversations or rewrite an existing summary.

The profile keeps at most 100 active records, 100 past/unconfirmed records and
40 follow-up records, prioritizing pending topics. Device threads remain intact.
In-process writes serialize PC/iPhone updates and replace profiles atomically.
Unreadable profile files are reported as unavailable and are not silently replaced.

Companion POST operations: `memory`, `memory_correct` (`id`, `text`),
`memory_forget` (`id`), and `followup_close` (`id`). Responses include `shared`,
`revision`, active/unconfirmed `memories`, and pending `followups`.

Verification:

```powershell
python -m pytest tests/test_hq_companion_memory.py tests/test_hq_ai.py tests/test_hq_life.py tests/test_hq_companion_context.py tests/test_hq_model_routing.py tests/test_hq_budget_integrity.py -q
node --check assets/hq-companion.js
```
