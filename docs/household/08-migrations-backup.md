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

Bundle household (script futur `scripts/backup_household.py`) :

1. `PRAGMA wal_checkpoint(FULL)` / ou `VACUUM INTO` snapshot.
2. Copier `household.sqlite` (+ `-wal/-shm` si besoin selon méthode).
3. Copier `schema_meta.json`.
4. Optionnel : inclure `hq_inventory.snapshot_bytes()` dans le même dossier tampon
   avec manifeste `{inventory_rev, household_schema, taken_at}`.
5. Vérifier tailles + hash manifeste.

Restauration testable :

1. Restaurer dans un ROOT jetable.
2. Ouvrir modules en lecture.
3. `validate` schémas + compteurs smoke.
4. Seulement alors promouvoir.

Intégration backup HQ existant (`backup_dir`) : ajouter le dossier
`.hq-household/` à l'ensemble sauvegardé **quand** le runtime existera — hors #30.

## Imports

Fichiers utilisateur sous `.hq-household/imports/` : conservés après import
échoué (debug) ; pas de parse dans les logs.
