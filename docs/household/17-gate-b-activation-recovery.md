# Gate B — activation, backup, recovery

Operator notes for Household v7. **No production writes are authorized by this document alone.**

## What already exists

- SQLite shell `hq_household_store` (schema **7**), finances / grocery / meals / inventoria / purchases modules
- Bridge routes under `/api/finances|grocery|meals|inventoria|grocery/purchases/*` (admin + CSRF)
- Private `backup()` / `restore_to_temp()` APIs
- HQ nightly/forced backup via `cc_ext.run_backup` (folders + Carnet)

## What Gate B backup adds

- `hq_household_store.snapshot_to` — verified, atomic publish for HQ backup packages
- `cc_ext._backup_household` wired into the **existing** `run_backup` cadence
- Catalog + retention awareness for Household (no second scheduler)

## Initialization (first write)

Supported path: authenticated **admin** CSRF `POST /api/finances/accounts` (or any other admin Household writable POST).

Creates under the state root:

| Path | Purpose |
|------|---------|
| `.hq-household/` | sealed directory |
| `.hq-household/household.sqlite` (+ WAL sidecars after open) | schema v7 DB |
| `.hq-household/schema_meta.json` | healable mirror of `user_version` |
| `.hq-household/backups/` | private store snapshots |
| `.hq-household/imports/` | import drop zone |

Default row: household name `Foyer`, currency `CAD`, locale `fr-CA`, timezone `America/Toronto`.

Does **not** create:

- `.hq-inventory/inventory.json`
- Inventoria sessions/ops (tables exist empty)
- Automatic stock deductions or grocery ledger posts

`GET /api/finances/summary` on a missing store → `404 store_absent` and creates nothing.

## Backup timing

1. **Before** first production init: rely on pre-Household checkpoint / existing folder backups.
2. **Immediately after** first successful init: force `run_backup` (or call `backup()` + confirm `snapshot_to` via the next scheduled run).
3. Ongoing: same `backup_every_hours` / `backup_dir` as today; package appears as `<backup_dir>/<stamp>/Household/`.

## Restore a verified Household backup

1. Locate `<backup_dir>/<stamp>/Household/household.sqlite` and its `.manifest.json`.
2. In a disposable ROOT: `hq_household_store.restore_to_temp(snapshot, dest_root=…)`.
3. Verify `integrity_check == ok`, `schema_version`, smoke reads.
4. Only then manually promote (operator-controlled copy into the real state root while the bridge is stopped) — **not** automated by HQ.

Never raw-copy a live `household.sqlite` while WAL is active; always use `backup()` / `snapshot_to`.

## Failed or partial initialization

- `open_store(create=True)` rolls back a brand-new failed DB (unlinks incomplete file + sidecars).
- If `.hq-household` exists but opens fail → refuse; keep bytes; restore from last good snapshot into a temp ROOT.
- Do not delete production `.hq-household` without a verified snapshot.

## Bridge restart during a write

- SQLite transactions + `busy_timeout` serialize writers.
- Incomplete HTTP requests do not leave a half-applied domain mutation if the module uses `st.transaction()`.
- After restart, sessions are independent of Household DB; re-auth as needed.
- Next `run_backup` will snapshot the durable committed state only.

## Legacy inventory JSON

- `hq_inventory` remains a separate v1 JSON store.
- Household init does **not** migrate or rewrite `inventory.json`.
- Cross-store inventoria commits remain explicit admin ops; grocery list build does not auto-adjust stock.

## Preserving data across software releases

- Durable authority: `PRAGMA user_version` inside `household.sqlite`.
- Newer code may migrate upward on writable open (with pre-migrate `backup()`).
- Downgrade (DB version > code) is refused.
- Keep HQ backup packages and private `.hq-household/backups/` across release swaps; state root stays `C:\hq-state\live`.
