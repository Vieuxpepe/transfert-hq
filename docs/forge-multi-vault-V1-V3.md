# Forge Studio: several vaults, V1 to V3 (storage, sessions, routes)

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


Implements V1 to V3 of `docs/forge-multi-vault-plan.md`. Nothing visible yet: the interface is V4; icon and sort are V5; per-vault backup, restore and delete are V6.

## Disk

- `forge-vault/registry.json`, plain, version 1: `{"version": 1, "legacy": <vid or null>, "vaults": [{id, label|null, glyph, colour, discret, order, created, last_used_day}]}`. `legacy` names the migrated vault that the old routes alias. Checked field by field (`hq_forge_vault_registry.py`): fixed glyph and colour sets, label 1 to 40 printable characters without `<>`, days only, at most 12 entries, no other keys. Any oddity rejects the whole file (`registry`, 409, "La liste des coffres est illisible. Aucun coffre n'est ouvert.").
- `forge-vault/vaults/<vid>/` holds exactly the old structure (`vault.json`, `index.bin`, `objects/`). `vid = "vlt-" + 16 random hex`. A vault created here writes its vid in `vault.json`; a folder whose header names another vid is refused, so swapping folders cannot mix two vaults. Only the migrated vault may have no vid in its header.
- The registry has no cryptographic weight: each vault keeps its own keys, and a session holds one vault key at most.
- Discret: the name is absent from the registry and sealed in `vaults/<vid>/label.bin` (AES-GCM, the vault's master key, AAD `hq-forge-vault-v1-label`). While locked, the list shows glyph, colour and number only.
- Quotas: 2 GiB and 400 images per vault (`QUOTA_BYTES`, `QUOTA_IMAGES`).
- Limites globales, **confirmées par Emie** (constantes nommées) :
  - `GLOBAL_QUOTA_BYTES` = 8 GiB pour tous les coffres ensemble ;
  - `GLOBAL_QUOTA_IMAGES` = 1600 images pour tous les coffres ensemble ;
  - `GLOBAL_MAX_VAULTS` = `hq_forge_vault_registry.MAX_VAULTS` = 12 coffres.

## Migration of the existing single vault

- Only `POST /api/forge/vaults/migrate` migrates, and only when the server itself has recorded the backup offer for this HQ session (fix 1): either the single vault's ZIP was downloaded (`GET /api/forge/vault/backup` until V4, `GET /api/forge/vaults/migration/backup` since), or the panel called `POST /api/forge/vaults/backup-offer` (admin + CSRF) after showing the offer. The record lives in memory, lasts 15 minutes, is used up by one attempt and is forgotten at logout. A client `backup_offered` flag is ignored; without the record the answer is `backup_first` (409, "Proposez d'abord la sauvegarde du coffre."). Start-up, status, jobs and cleanup never migrate.
- Each vault's backup ZIP includes `label.bin`, still sealed; restore puts it back and refuses a label that the restored key cannot open (fix 2).
- Two renames, no copy, no re-encryption: `forge-vault` becomes `forge-vault.migrating`, a new `forge-vault/vaults/` is made, and `forge-vault.migrating` becomes `forge-vault/vaults/<vid>`. A journal `forge-vault.migration.json` (vid only) is written before the first rename. The registry (label « Coffre », default glyph and colour) is written after the second rename. Then the owner-only ACL and the link checks are re-applied at the new place.
- At the next start, `cleanup_partials` finishes a cut-off migration. If two copies exist it refuses and leaves both. `cancel_migration` puts the single vault back while it is the only vault.

## Sessions and tries

- One unlock entry per HQ session, bound to the vault it opened. Opening another vault wipes the first key. Lock, logout, `lock_all`, `retain_only` and the TTL drop the key and the cached search rows. A passphrase change or recovery rotation closes only the sessions that have that vault open (fix 3); restore and migration still close every session.
- Failure counts are kept per (session, vault), plus one global count over every vault (5 failures, then 60 s). A success clears only its own slot, so knowing one vault's phrase does not reset the global count. The global count resets after a quiet minute. Logout does not reset counts.
- Private jobs take `"vault": <vid>` (kept in memory only, never in `jobs.json`), and that vault must be open in this session. Once vaults exist, a private job without a vault is refused (`use_vaults`). A private retouch reads and writes only its source's vault (`source.vault`). Laboratoire and the night workshop are unchanged and still exclude every vault.

## Routes (all admin + CSRF; none unauthenticated)

- `GET /api/forge/vaults`: read-only list of the registry fields, a number, and the open vault id.
- `POST /api/forge/vaults/new`: `{passphrase, confirm, label, glyph, colour, discret}`, returns 201 with the recovery key once. The vault is not opened.
- `POST /api/forge/vaults/<vid>/settings`: name, glyph, colour, Discret, order. Discret changes need the vault open in this session.
- `POST /api/forge/vaults/migrate`.
- `/api/forge/vaults/<vid>/` plus `status`, `unlock`, `recover`, `lock`, `passphrase`, `recovery`, `gallery`, `images/...`, `search`, `import`. Setup, backup and restore are not routed per vault (V6). No delete route.
- `/api/forge/vault/*` was the alias of the migrated vault until V4. V4 removed it: every old route answers 404 (`docs/forge-multi-vault-V4.md`).
- Ids only in paths; names travel only in POST bodies and are never logged.