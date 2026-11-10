# A — Cohérence SQLite ↔ Inventaire JSON

Contrat dur pour toute mutation future qui touche **à la fois**
`.hq-household/household.sqlite` et `.hq-inventory/inventory.json`.
Ce n'est **pas** une transaction ACID unique.

---

## 1. Journal d'opérations (`cross_store_ops`)

Table SQLite (schéma logique v1) :

| Colonne | Type | Rôle |
|---------|------|------|
| `id` | `xop-<16hex>` | Identifiant op |
| `kind` | text | `inventoria_commit` \| `grocery_purchase` \| `lot_consume` \| … |
| `idempotency_key` | text UNIQUE | Clé client/serveur (voir §2) |
| `status` | text | Voir machine d'états |
| `request_hash` | text | SHA-256 hex **64** chars du body normalisé |
| `planned_steps` | JSON | Liste ordonnée (voir §1.1) |
| `step_index` | int | Prochaine étape (`0..len(planned_steps)` inclus) |
| `step_results` | JSON | Résultats partiels (revs item, qty **si connus**) |
| `inventory_rev_before` | int? | Snapshot `doc.rev` avant toute écriture JSON (diagnostic only) |
| `inventory_rev_after` | int? | Observé après ack inventaire |
| `uncertain_inventory` | int `0\|1` | **1** si un apply inventaire est douteux |
| `reconcile_plan` | JSON? | Actions humaines/serveur autorisées |
| `error_code` | text? | Dernier échec |
| `created_at` / `updated_at` | real | Epoch |
| `closed_at` | real? | Terminal |

### 1.1 `planned_steps` + phases d'attempt inventaire

Chaque étape :

```json
{
  "store": "sqlite" | "inventory",
  "action": "item.adjust" | "…",
  "payload": { },
  "attempt_phase": "not_started" | "in_flight" | "acknowledged"
}
```

Pour `store=inventory` : **`attempt_phase` explicite** (pas de défaut silencieux)
**et** `payload` valide typé (même contrat qu'Inventoria). Absent → `validation_error`.

Invariant **`committed`** : toute étape `inventory` doit être `attempt_phase=acknowledged`.
Une op `committed` avec étape `not_started` / `in_flight` est **invalide**.

| Phase | Sens | Persistée quand |
|-------|------|-----------------|
| `not_started` | Aucun appel `hq_inventory.apply` n'a été tenté pour cette étape | À la planification |
| `in_flight` | L'appel **peut** avoir commencé ou réussi — résultat **non** journalisé | **Avant** l'appel `apply` (write durable) |
| `acknowledged` | Résultat durable enregistré dans `step_results` | **Après** apply + journal résultat |

**Ambiguïté F3→F4 corrigée :** un status global `applying_inventory` **ne prouve
pas** que `item.adjust` n'a pas déjà tourné. Seule la phase par étape compte.

Au redémarrage :

| `attempt_phase` | Action auto |
|-----------------|-------------|
| `not_started` | `may_start_once` (si `uncertain_inventory=0`) |
| `in_flight` | **`needs_reconcile`** — jamais de rejeu auto |
| `acknowledged` | skip |

**Interdit :** déduire le succès d'un delta de la seule `inventory_rev` globale
(d'autres clients peuvent avoir écrit).

### Machine d'états (op)

```text
accepted
  → preparing
  → applying_sqlite
  → applying_inventory
  → finalizing
  → committed

  ↘ needs_reconcile
  ↘ failed
  ↘ cancelled
```

---

## 2. Clés d'idempotence

| Champ | Règle |
|-------|-------|
| Format | 8–128 chars |
| `request_hash` | SHA-256 hex minuscule, **exactement 64** chars |
| Même clé + même hash | Retour résultat existant |
| Même clé + hash ≠ | **409** `conflict` |
| Clé absente sur mutation cross-store | **400** |

---

## 3. Frontières d'écriture et récupération crash

```text
F0  INSERT op status=accepted + idempotency_key + request_hash
F1  UPDATE preparing + planned_steps (phases=not_started)
F2  SQLite domain writes status=applying_sqlite
F3  status=applying_inventory ; inventory_rev_before=snapshot (diag)
F3b PERSIST step.attempt_phase=in_flight   ← durable, avant apply
F4  hq_inventory.apply(step)
F5  record step_results ; attempt_phase=acknowledged
F6  SQLite finalize + status=committed
```

| Crash entre | État | Récupération |
|-------------|------|--------------|
| F0–F1 | `accepted`/`preparing` | Reprendre prepare ou cancel TTL |
| F1–F2 | `preparing` | Rejouer prepare idempotent |
| F2–F3 | `applying_sqlite` | Reprendre SQLite ; **pas** d'inventaire |
| F3–F3b | `applying_inventory`, phase `not_started` | Peut `may_start_once` (F3b puis F4) |
| F3b–F5 | phase `in_flight` | **`needs_reconcile`** ; `uncertain_inventory=1` ; **aucun** rejeu auto d'`item.adjust` |
| F5–F6 | `acknowledged`, non finalisé | Finalize SQLite only |

`may_auto_replay_inventory_step(action, uncertain, attempt_phase)` retourne
`True` **uniquement** si `attempt_phase=not_started` et non uncertain.

---

## 4. `item.adjust` — interdiction de rejeu aveugle

1. Phase `in_flight` ou `uncertain_inventory=1` → reconcile only.
2. `reconcile_plan` : `inspect` | `confirm_already_applied` | `confirm_not_applied` (nouvelle sous-clé) | `abort_compensate`.
3. Heuristique **interdite** : « rev store a bougé ⇒ adjust déjà appliqué ».

---

## 5. Conflits / reprise

| Signal | Comportement |
|--------|--------------|
| `expected_inventory_rev` ≠ courant **avant** F3b | 409 ; pas d'écriture |
| Item `rev` mismatch update/delete | stop batch |
| Idempotency conflict | 409 |
| `needs_reconcile` | seul `POST …/reconcile` avance |

---

## 6. Tests crash / double soumission (runtime futur)

| ID | Scénario | Attendu |
|----|----------|---------|
| CS-01 | Double POST même clé+hash | Un seul apply |
| CS-02 | Même clé, hash ≠ | 409 |
| CS-03 | Crash F3–F3b (`not_started`) | Reboot → `may_start_once` |
| CS-03b | Crash F3b–F5 (`in_flight` adjust) | `needs_reconcile` ; **pas** de rejeu |
| CS-04 | Inject apply sans ack | idem CS-03b |
| CS-05 | Ack OK, crash avant finalize | Finalize SQLite only |
| CS-06 | 409 rev mid-batch | stop |
| CS-07 | Deux clés parallèles | journaux distincts |
| CS-08 | `confirm_not_applied` + retry | un apply, sous-clé |

Tests fondations #30 : `may_auto_replay_inventory_step` + `recovery_for_inventory_step`
+ validation phases dans `tests.test_household_schemas`.
