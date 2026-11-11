# Stratégie migrations et sauvegarde

## Versions

- SQLite : `PRAGMA user_version` = `schema_version` household (démarre à **1**).
- Miroir : `.hq-household/schema_meta.json` `{schema_version, applied_at, app_rev}`.
- Schémas JSON docs : `schemas/household/*.v1.json` — bump → `*.v2.json` +
  migration numérotée, pas d'édition destructive silencieuse.

## Migrations non destructives

| Règle | Détail |
|-------|--------|
| Expand-contract | Ajouter colonnes nullable / tables nouvelles d'abord |
| Jamais DROP immédiat | Colonne obsolète : période de double-écriture puis PR dédiée |
| Fail-closed | Migration échouée → refuse démarrage module ; fichier DB intact |
| Pas d'auto-migrate inventaire JSON | `hq_inventory` reste v1 ; liens `item_id` seulement |
| Backup avant migrate | Snapshot SQLite + copie `inventory.json` si op cross-store |
| Pas de réparation silencieuse | Never auto-rewrite envelope ``currency`` on ``open_store`` (ambiguous vs intentional CAD in a USD household) |

### SQLite v4 — épicerie (produits, lots, commerçants)

Tables ``products``, ``food_lots``, ``merchants`` ; aucune mutation Inventoria ni ledger automatique (PR #33).

### SQLite v5 — repas et listes d'épicerie (PR #34)

Tables ``recipes``, ``meal_plans``, ``grocery_lists``, ``grocery_list_build_idempotency``.
Ingrédients, étapes, créneaux de plan et lignes de liste sont stockés en colonnes JSON
(``ingredients_json``, ``steps_json``, ``slots_json``, ``lines_json``) avec validation Python
à l'écriture (contrats ``meals.v1`` / ``grocery.v1``). Les ``substitutes[]`` des recettes
sont des suggestions documentées (``product_id`` ou ``name``) — jamais appliqués automatiquement.
Choix : une ligne parente + JSON pour
révisions atomiques (CAS sur ``rev``) et listes bornées (≤100 ingrédients, ≤400 créneaux, ≤500 lignes)
sans explosion de tables relationnelles en v1. Aucune écriture Inventoria ni ledger ; le build-list
preview ne persiste rien ; commit idempotent via ``grocery_list_build_idempotency``.

### SQLite v7 — moteur Inventoria (PR #37 core)

Tables ``inventoria_sessions``, ``inventoria_operations``, ``inventoria_operation_audit``,
``inventoria_commit_idempotency``. Pipeline **propose → validate → preview → commit**
sans écriture inventaire avant ``commit`` ; commit cross-store via journal
``cross_store_ops`` (``kind=inventoria_commit``) et ``hq_inventory.apply_guarded``.
``adjust_inventory`` sur achats reste **501** (inchangé v6).

### SQLite v6 — achats réels (PR #35 core)

Tables ``actual_purchases`` (unicité ``fingerprint`` par foyer), ``purchase_idempotency``,
``cross_store_ops`` (journal **préparatoire** uniquement). ``POST /api/grocery/purchases/actual``
peut écrire achat + transaction ``grocery_purchase`` + lot dans **une** transaction SQLite
(**SQLite-only fonctionnel** pour cette PR).

- ``adjust_inventory`` renvoie **501** — aucun ``hq_inventory.apply()``, aucun ``item.adjust``
  best-effort, **aucune synchronisation Inventoria**.
- Le critère de réconciliation SQLite↔Inventoria **n'est pas satisfait** ; ne pas présenter
  cette livraison comme une réconciliation cross-store complète.
- Montants d'achat en centimes : devise implicite = ``households.currency`` ; compte financier
  doit avoir la même devise (pas de conversion FX).
- Isolation foyer : ``account_id`` / ``category_id`` validés côté achats **et**
  ``insert_transaction(..., via="grocery_purchase")`` (pas de confiance FK seule).
- Unicité durable : index ``idx_actual_purchases_idempotency`` UNIQUE non-partiel
  ``(household_id, idempotency_key)`` — validé via ``PRAGMA index_list`` (``unique=1``, ``partial=0``)
  et ``PRAGMA index_xinfo`` (exactement deux colonnes ``key=1``, pas d'expression) ;
  réparation writable = sauvegarde ``pre-v6-idem-index`` + transaction DDL (refus si doublons).
- Clé finance dérivée = SHA-256 64 hex (bornes 8–128 sur la clé achat).
- Pas de table ``planned_purchases``.

### SQLite v3 — colonne ``budget_envelopes.currency``

- **Contrat API** : ``schemas/household/finances.v1`` (entité ``budget_envelope.currency``) — distinct de ``PRAGMA user_version`` 3.
- Migration v2→v3 : backfill depuis ``households`` pour les lignes **sans** devise (colonne nouvelle).
- Bases v3 déjà déployées avec l’ancien ``DEFAULT 'CAD'`` : **pas** de réparation automatique à l’ouverture ; cas ambigus → sauvegarde manuelle, analyse, réconciliation opérateur (SQL ou outil dédié futur).

Algorithme d'ouverture (futur module) :

1. Si dossier absent → créer DB vide v1.
2. Si `user_version` > code → **refuser** (downgrade interdit).
3. Si `user_version` < code → backup → appliquer migrations 1…N dans une
   transaction SQLite → vérifier invariants → commit meta.
4. Toute exception → restore backup + erreur opérateur.

## Sauvegardes cohérentes

### API store (locale)

- `hq_household_store.backup(root, label=…)` → snapshot privé sous
  `.hq-household/backups/` + manifeste SHA-256 (via `Connection.backup()`,
  WAL inclus dans le fichier unique).
- `hq_household_store.restore_to_temp(snapshot, dest_root=…)` → ROOT **jetable**
  uniquement ; refuse une cible déjà peuplée ; jamais de remplacement silencieux
  de la DB active.

### Intégration backup HQ (`cc_ext.run_backup`)

Même cadence / `backup_dir` / rétention que les dossiers + Carnet — **pas** de
second scheduler.

1. `hq_household_store.snapshot_to(root, dest/Household)` :
   - store **absent** → `{status:"absent"}` — **aucune** création sous le ROOT live ;
   - store présent → `Connection.backup()` vers un staging, `integrity_check`,
     manifeste SHA-256, publication **atomique** (`os.replace` du dossier) ;
   - DB corrompue → `{status:"invalid", valid:false}` **sans** publier le dossier.
2. Entrée catalogue `hq_backup_index.json` : clé `household` (status/ok/included/valid/schema_version)
   + `complete` / `incomplete_reason` sur l'entrée globale.
3. Sémantique opérateur : `ok:true` = dossiers legacy copiés (compatibilité) ;
   **`complete:true`** = Carnet + Household sains ou légitimement absents.
   Échec / invalid Household → `complete:false`, alerte `Backup incomplet`, Discord
   « incomplet », purge suspendue (`household_snapshot_failed` / `household_invalid`).
4. Rétention : si snapshot Household échoué ou invalid → **purge suspendue**
   (`household_snapshot_failed` / `household_invalid`), comme pour Carnet.
5. Contenu publié : `household.sqlite`, `household.sqlite.manifest.json`,
   optionnellement `schema_meta.json`. **Pas** de sessions, PIN, `bridge_config`,
   ni copie brute `-wal`/`-shm`, ni `inventory.json` (Inventoria JSON reste hors
   de ce paquet).

Rétention globale inchangée : `backup_keep_days` / `backup_keep_min` via
`purge_old_backups` après un backup réussi et non bloqué.

Restauration testable :

1. Prendre `…/<stamp>/Household/household.sqlite` (+ manifeste).
2. `restore_to_temp` dans un ROOT jetable.
3. Ouvrir en lecture : `integrity_check`, `schema_version`, smoke API.
4. Promotion manuelle seulement après validation — jamais d’overwrite automatique
   de `.hq-household/` live.

## Imports

Fichiers utilisateur sous `.hq-household/imports/` : conservés après import
échoué (debug) ; pas de parse dans les logs.
