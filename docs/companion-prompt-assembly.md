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
| Delivery | `delivery_hint` | Cadence and at most one contextual habit; no repeated identity catalog |

The intensity comparison has one home in the full core, independently of edited
humour fields. A neutral reply does not repeat stable temperament in the dynamic
response plan. User-provided evidence remains data, not a new system instruction.

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
