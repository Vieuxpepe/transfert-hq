# Companion prompt assembly

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


`hq_companion_context.py` is a pure selector; `hq_ai.build_companion_context`
owns budget validation and request telemetry. It adds no model calls, storage,
background workers or animation work. The configured budgets and conservative
UTF-8-plus-message-overhead estimator are unchanged; provider usage remains the
source of billed token counts.

## Instruction ownership

| Layer | Owner | Contents |
| --- | --- | --- |
| Stable core | `build_transferania_system` / `character_hint` | Identity, family, personality, register and grounding rules |
| Current behavior | `prompt_hint` / `response_hint` | Task, comfort, repair, recall and a non-neutral response plan |
| Evidence | Shared memory / life context | Current corrections, reported facts, actual events, stated reasons |
| Summary | Existing summary lifecycle | Choices, explicit reasons, corrections, open/resolved threads |
| Conversation | Whole paired exchanges | Latest continuity and older user-topic relevance |
| Internal state | `hq_personhood.state_line` / `regime` / `withholds_initiative` | Her own decaying energy/tension/warmth, the last thing that moved it, and the bounded `régime` that turns it into brevity, openness or a closed subject; one `behavior` block, never identity. While the grade is tense every unprompted offer is withheld at its own source — follow-up, absence callback, motif callback, visit continuity, her open-thread/self-note/contested/value note, a follow-up registered from her own question, and the spontaneous ambient lines (Transferania and Else); records stay pending and nothing is reserved, explicit recall and requested reflections stay open by design, and a personhood read that raises fails open |
| Delivery | `delivery_hint` | Cadence, the opening she must not repeat, the social chat shape, and at most one contextual habit; no repeated identity catalog |

The intensity comparison has one home in the full core, independently of edited
humour fields. A neutral reply does not repeat stable temperament in the dynamic
response plan. User-provided evidence remains data, not a new system instruction.

## Chat aliveness

The mandatory chat core is size-bound (the configured budget must fit instructions
plus the current message), so aliveness is split by ownership rather than grown in
the core. `CHAT_WARM` / `CHAT_FLIRT` keep their compact size and state the chat
contract in one line each: a réplique rather than a report, a reaction before the
answer, a precise detail, a held position, variation between turns, and for flirt
initiative that drops on a refusal, silence or serious subject. `CHAT_REGISTER`
carries the same contract for callers that build a non-core prompt, and still
allows an occasional emoji.

Delivery owns the per-turn moves, so they are selectable evidence rather than
mandatory instructions:

| Part | Source | Contents |
| --- | --- | --- |
| Cadence | `voice_hint` | Short/long cadence plus the opening not to repeat, taken from her own previous line (`opening_avoid`, first word only); no extra history, no user fact derived |
| Shape | `shape_hint` | Social turns only: react before informing, a precise detail over a synthesis, one held position, at most one question; a repair turn corrects cleanly instead |
| Habit | `quirk_hint` | The existing single contextual habit |

Identity, temperament, family and intensity are not restated in any of the three,
and a task or comfort turn keeps its own behaviour hint instead of the social shape.

The mandatory core also had to get back inside the tight budgets the evaluation
uses (`tight_budget` at 6 000 B, the personhood-share case at 6 200 B): the
duplicated « incarnation » and sister sentences in `CHARACTER_SHEET`, `LIFE_RULE`
and the core memory rule were compressed to their non-redundant content (family
canon, Live2D incarnation and the stable tastes stay). The warm chat core is now
about 5 900 B, so a small budget is spent on evidence (corrections, real events)
rather than on repeated instructions.

Reproduce the chat behaviour without a model call:

```bash
python scripts/verify_chat_aliveness.py      # 6 scripted turns, payload evidence
python -m unittest tests.test_chat_aliveness -q
python scripts/verify_live_chat_prompt.py    # read-only probe of the running bridge
```

## Selection and serialization

The core and current message are mandatory, whole and unchanged. An oversized
mandatory input fails before reply generation; summary work is also skipped when
it cannot solve that overflow.

Remaining whole blocks are selected by priority:

1. Current relevant corrections and real events/results.
2. Time context and current task/comfort/repair guidance.
3. Retrieved memories and the existing summary.
4. The latest two complete exchanges, newest first during selection.
5. Page context, continuity, and older exchanges ranked by lexical relevance to
   the current request. Older zero-overlap exchanges are omitted.
6. Cadence and optional character habits.

History relevance uses the old user's message, not claims made by the assistant.
Oversized pairs are skipped as a whole; they do not prevent a smaller useful pair
from fitting. Selected pairs are serialized chronologically. Page blocks retain
their relative order under a single heading. Exact duplicate blocks are omitted.
At most five memory/correction slots are used. No durable archive is pruned.

Previously summarized exchanges remain eligible for relevant retrieval; the
summary marker still controls incremental compression, not archive accessibility.
No algorithm guarantees every event fits an arbitrarily small budget: omissions
are explicit in the inspector, and continuity reservations are released if the
selected prompt did not retain their text.

## Decision-focused summaries

The local fallback retains complete source statements, labels User/Transferania,
and prioritizes decisions plus their explicit reasons, corrections, preferences,
open work and reported completion. Replaced preferences are marked; a narrowly
matching completion can close an old thread. Finishing one robot subtask does
not automatically close another. Assistant proposals remain dialogue rather
than user decisions. Legacy unlabelled summaries remain historical context.

The existing optional model summary uses the same focus and attribution rules;
its cooldown, thresholds, call accounting and fallback are unchanged. Summaries
remain bounded to 1,400 characters, without cutting an output line mid-statement.
This is conservative extraction, not unrestricted semantic understanding.

## Inspector and privacy

**Éditer Transferania → Contexte API → Préparer l’aperçu sans envoyer** now shows
the included and omitted sections, fixed source categories, source-text sizes,
paired-history indices and reasons (priority/budget, duplicate, irrelevant).
The detailed view is capped at 200 rows; complete aggregate counts remain visible.

The manifest contains no prompt text, matched words, memory topics, content hashes
or credentials. It is returned only with the explicit read-only preview, not in
routine chat responses or on-disk usage logs. Logs may retain sanitized numerical
counts by reason. Preparing the inspector calls no model and changes no memory.

## Repeatable evaluations

```powershell
python scripts/evaluate_companion_prompts.py
python -m unittest tests.test_hq_companion_prompt_pipeline tests.test_hq_companion_prompt_eval -q
python tests/visual_hq_companion_character_playwright.py
```

The JSON cases cover greetings, shared corrections, comfort, practical requests,
sister dialogue, long history, recent repetition, unknown rituals, changed
opinions and tight budgets. Each case uses isolated temporary storage and a fake
provider; the default evaluation makes zero model calls. The report records
grounding/selection contracts, character-guidance distinction, repetition guards
and input estimates. It is not a generated-response quality or hallucination
score. Actual wording still needs review when sampling a live model.
