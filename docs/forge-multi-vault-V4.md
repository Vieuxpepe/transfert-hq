# Forge Studio: several vaults, V4 (interface)

Implements V4 of `docs/forge-multi-vault-plan.md` on top of V1 to V3. Icons and sorting are V5; per-vault backup, restore, delete and phrase/key screens are V6.

## Mes coffres

- Cards in two columns from 375 px: a 44 px glyph tile on its colour, the name (or "Coffre n° N" for a Discret vault while locked), and "Ouvert" or "Verrouillé". Touching a locked card opens its unlock sheet; one vault is open at a time and the sheet says which open vault will be locked. After the switch the note says which one was locked and which one is open; a Discret vault is named by its number in any message that outlives its open state.
- Creation: name, glyph, colour, Discret, phrase and confirmation. Warning "Ne mets rien de sensible dans le nom" (Discret explains the number instead). The recovery key is shown once and cleared from the page by "J'ai enregistré la clé". A new vault stays locked.
- Private generation: "Coffre de destination" is chosen by the owner. Opening a vault from its sheet makes it the destination; choosing a locked vault opens its sheet; with no destination, Générer asks for one and sends nothing. The job carries `"vault": <vid>`.
- Lock, logout, the 5 min idle lock and "Verrouiller en quittant l'app" close the vault (`POST /api/forge/vaults/lock`). The page then drops decrypted thumbnails, the viewer, search words, Discret names (cards, notes, destination menu) and the gallery title before any request returns.
- The per-vault "Sauvegarde chiffrée" button is gone until V6 (per-vault backup). The migration screen has its own ZIP.

## Migration of the existing single vault

- Shown instead of the list while the layout is `legacy`. It says the vault moves without re-encryption and never by itself.
- Steps: open with the usual phrase (`POST /api/forge/vaults/migration/unlock`, or `/migration/recover`), then the ZIP (`GET /api/forge/vaults/migration/backup`) or an explicit "Continuer sans sauvegarde" (`POST /api/forge/vaults/backup-offer`), then "J'ai compris" and "Déplacer mon coffre" (`POST /api/forge/vaults/migrate`).
- Server rule (tightened in V4): the offer and the migration both need the single vault open in this HQ session, and the offer is bound to that very unlock. Locking, the idle TTL, logout or another unlock cancels it; it also expires after 15 minutes and is used up by one attempt. The screen says so and asks for a new ZIP.
- After success the vault is in Mes coffres (label "Coffre"); every session was closed by the migration, so it opens again with the same phrase.
- Until the owner migrates, private generation and the private gallery wait: the screen asks to move the vault first. Nothing is lost and the vault is not touched.

## Routes (all admin + CSRF; 401 anonymous, 403 other roles or cross-site)

- `GET /api/forge/vaults/migration`: `{layout, configured, unlocked}`; configured/unlocked only for `legacy`.
- `GET /api/forge/vaults/migration/backup`, `POST /api/forge/vaults/migration/unlock`, `POST /api/forge/vaults/migration/recover`: only while the layout is `legacy` (404 otherwise).
- `POST /api/forge/vaults/lock`: closes whatever vault this session has open.
- The old `/api/forge/vault/*` alias is removed: 404 for every old path, before and after migration.