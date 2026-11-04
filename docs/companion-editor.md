# Companion editor in HQ

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
Static. This relationship canon does not fabricate shared conversations,
merge memories or authorize messages between the sisters.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Open Transferania's bubble and choose **Éditer**.

- **Personnalité** edits humour, curiosity, strength/scale, the signature trait,
  flirtation and the two compact ambient voices. Save applies to the authenticated
  owner's PC and iPhone. **Restaurer les traits par défaut** removes overrides.
- **Contexte API** assembles chat or ambient input locally, showing the complete
  system instructions, selected messages, estimated input/budget, memory count
  and omitted-history count. Preparing this preview makes no provider calls and
  changes no stored memory, transcript, cooldown, quota or summary.
  Expand **Pourquoi ces sections sont incluses ou omises** for source categories,
  text sizes, history indices and omission reasons. Estimates are conservative
  UTF-8 units, not provider token counts. The detailed manifest is not logged.
- **Souvenirs et évolution** opens the shared memory manager, including editable
  facts, removable source moments, derived views and closable follow-ups.

The preview is a snapshot of current stored state, not a stored trace of a past
request or a promise that the next request will be identical. Sending a message
can update memory, the summary, time and events. The editor intentionally does
not offer raw system/core-rule editing, credentials or arbitrary storage access.

## Persistence and limits

Optional `personality` overrides and `personality_revision` live in the existing
owner-hashed memory profile. Old profiles retain defaults without migration.
Only changed fields are stored. Personality revisions are independent of ordinary
memory updates, so background chat cannot invalidate an editor draft. A stale
personality save from another device is rejected instead of silently replacing
newer traits; select **Personnalité** again to load the current version.

Each main trait is limited to 2400 UTF-8 bytes, their combined editable content to
4200 bytes, and each ambient voice to 320 bytes. Saves are also checked against
configured input budgets before writing. Existing chat and ambient input/output
limits, preference controls and device transcript boundaries are preserved.

Admin-only `transferania` operations: `personality`, `personality_save` (traits,
revision), `personality_reset` (revision), and `context_preview` (kind, message,
view, digest, persona, nsfw). The authenticated owner, never a body parameter,
selects the profile. Context preview is available to authenticated admin sessions
on phones as well as the desktop. The older localhost-only tuning preview stays
unchanged. No private prompt text is added to telemetry.

## Verification

`tests/test_hq_companion_editor.py` checks shared editing, owner isolation, stale
saves, restore defaults, validation, mode-specific fields, input budget rejection,
admin authorization, full preview accounting and no preview disk/provider effects.
Live HQ checks covered saving a temporary marker, observing it in the assembled
context, restoring the original defaults, both preview budgets, and a 390×844
layout. Phone viewport testing does not substitute for physical iPhone testing.
