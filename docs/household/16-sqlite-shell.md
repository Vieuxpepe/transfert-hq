# PR #31 — Household SQLite shell

Module : [`hq_household_store.py`](../../hq_household_store.py)

## Portée

Fondation opérationnelle **non branchée** au bridge :

| Inclus | Exclu |
|--------|-------|
| `.hq-household/household.sqlite` | Routes `/api/finances|grocery|meals|inventoria` |
| WAL + `busy_timeout` | Onglets UI / Inventoria FAB |
| Migrations v1 + miroir `schema_meta.json` | Tables métier finances/épicerie |
| ACL Windows / modes POSIX | Migration `hq_inventory` |
| `backup` / `restore_to_temp` | Activation ROOT production |

## Autorité de version

1. **`PRAGMA user_version`** = vérité durable.
2. **`schema_meta.json`** = miroir soignable (`authority: sqlite_user_version`).
3. Panne entre commit SQLite et miroir → prochaine ouverture **réécrit** le miroir ; pas de re-migration si `user_version` déjà à jour.
4. `user_version` > code → refus de downgrade.

## Garde-fous audit

- Migrations : **pas** d'`executescript` après `BEGIN IMMEDIATE` — DDL/DML/`user_version` via `execute` + rollback.
- ACL Windows : DACL remplacée (reset) pour SID bridge + SYSTEM ; vérification effective ; refus si Everyone/Users restent.
- Confinement : `.hq-household`, DB, `backups/`, `imports/`, snapshots et manifestes ; `_confined_file` refuse aussi les parents redirigés.
- Restore : manifeste SHA-256 **obligatoire** ; refuse cible déjà peuplée ; intégrité destination vérifiée.
- `user_version=1` sans tables Household → refus (`validate_schema_v1` après `integrity_check`).
- `PRAGMA journal_mode=WAL` **après** gates version/compatibilité (pas de `-wal`/`-shm` sur refus de downgrade).
- Miroir `schema_meta.json` : `schema_version` non-entier (objet/tableau/bool) → soigné, pas de `TypeError`.
- `readonly=True` : aucune écriture (meta/ACL/mkdir/WAL) ; `open_store` ne lit plus le fichier DB en entier.

## API

- `open_store(root, create=True, readonly=False)`
- `get_schema_version(conn)` / `migrate(conn)` / `integrity_check(conn)` / `validate_schema_v1(conn)`
- `backup(root, label=…)` → manifeste SHA-256
- `restore_to_temp(snapshot, dest_root=…)` → ROOT jetable uniquement
- `set_acl_for_tests(bool)` — tests seulement

Import du module : **aucun** fichier créé.

## Cross-store

Le shell n'exécute pas le journal SQLite↔JSON. Les futures écritures doivent respecter
[12-cross-store-journal.md](12-cross-store-journal.md) : `acknowledged` ⇔ `step_result` durable.

## Tests / CI

```bash
python -m unittest tests.test_household_store tests.test_household_schemas -v
```

Workflow : `.github/workflows/household-store.yml` (Linux). Contrôles ACL Windows dans
`WindowsAclTests` (natifs ; skippés sur Linux).
