# Mini-Quêtes

Bounded, **simulated** playground quests for Transfert HQ. They are not a shell,
terminal, sensor bridge, or hardware control surface.

## Functions

| Quest | Role | Side effects |
|-------|------|----------------|
| `simmer` | Timed warm-up | Runs `time.sleep` on a **worker thread** (never a CPU busy-wait). Writes one log line when done. |
| `pulse` | Synthetic beat | Returns a fixed playground reading. Always `simulated: true`. **Never** a biological or hardware sensor. |
| `gear_whisper` | Explicit journal note | Appends **one** sanitized line when called. Does **not** auto-log HTTP traffic. |

## HTTP routes

Admin session required (upload role → 403). Cookie CSRF applies to every POST.

| Method | Path | Effect |
|--------|------|--------|
| `GET` | `/api/mini-quests` or `/api/mini-quests/` | Catalog, limits, recent jobs (no state change) |
| `GET` | `/api/mini-quests/jobs/<16-hex>` | Job status poll |
| `POST` | `/api/mini-quests/simmer` | Start simmer (`duration_sec` optional, bounded) → `202` + job |
| `POST` | `/api/mini-quests/pulse` | Immediate synthetic pulse → `200` |
| `POST` | `/api/mini-quests/whisper` | Log `context` (optional string) → `200` |

Body cap: **4096** bytes. Unknown fields → `400`. Wrong method on a known prefix → deterministic `4xx` (no stack traces, no secrets).

## Limits

| Limit | Value |
|-------|-------|
| Concurrent long quests | 2 |
| Simmer duration | 0.1–3.0 s (default 1.0) |
| Whisper context | 160 chars, no control characters |
| Quest log rotate | ~64 KiB → `quest_log.txt.1` |
| In-memory jobs | 40, TTL 300 s |

Log lines are single-line, control-stripped, and scrubbed via `hq_diagnostics.scrub` (paths, long tokens, emails).

## Simulated data

Every successful payload includes `"simulated": true`. `pulse` also sets `sensor`, `biological`, and `hardware` to `false`. UI copy under **Plus → Mini-Quêtes** states the same.

## UI

Embedded in the existing **Plus / Système** panel (`#system-mini-quests`). No new primary nav tab until design validation. States: disponible, en cours, terminé, refusé, erreur.

## Out of scope

Finances, Repas & Épicerie, Inventoria, bridge-wide refactors, terminal/shell/hardware routes.
