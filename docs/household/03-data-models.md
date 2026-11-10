# Phase 2 — Modèles de données versionnés

Source de vérité machine : [`schemas/household/`](../../schemas/household/) +
[`hq_household_schemas.py`](../../hq_household_schemas.py).

Convention IDs : préfixe + 16 hex (`fin-`, `env-`, `tx-`, `prd-`, `lot-`, `rcp-`,
`ivo-`, …) sauf références inventaire existantes (`itm-`, `plc-`).

Argent : `*_cents: int` (CAD centimes par défaut ; `currency` ISO 4217).  
Quantités : jamais de float monétaire ; qty physiques = entiers en milli-unités
canoniques (`qty_milli`) **ou** entier + `unit` déjà canonique.  
Prix unitaires offres : `unit_price_ratio {cents_num, qty_milli_den}` (exact) —
pas de `unit_price_cents_per_canonical` (troncature).

---

## Commun (`schema_version: 1`)

| Champ | Type | Notes |
|-------|------|-------|
| `schema_version` | int | Toujours 1 dans cette fondation |
| `created_at` / `updated_at` | float epoch | Style HQ |
| `rev` | int ≥ 1 | Optimistic concurrency où pertinent |
| `idempotency_key` | str ≤ 128 | Mutations sensibles |
| `household_id` | `hhold-<16hex>` | Foyer courant (single-tenant v1) |

**Unités canoniques (v1)** : `g`, `ml`, `each`, `serving`.  
Équivalences : table `unit_equivalences` `{from_unit, to_unit, factor_milli}`
(ex. 1 cup oil → 240000 ml milli).

---

## Finances

### `households` / préférences

```
household {
  id, name, currency: "CAD",
  locale: "fr-CA",
  timezone: "America/Toronto",
  week_starts: "mon"|"sun",
  prefs: { soft_budget_warn_pct: 80, hard_block_overspend: false }
}
```

### `budget_categories`

`id`, `household_id`, `name`, `kind: income|expense|transfer`, `parent_id?`,
`archived: bool`, `rev`

### `accounts` (enveloppes de trésorerie, pas banques externes)

`id`, `name`, `kind: cash|checking|credit|savings|other`, `opening_balance_cents`,
`currency`, `archived`, `rev`

**Solde dérivé** = opening + Σ signed tx (jamais stocké comme float).

### `transactions`

```
transaction {
  id, household_id, account_id,
  booked_on: "YYYY-MM-DD",
  amount_cents: int,          # signe: + crédit compte, - débit
  category_id,
  payee: str,
  memo: str,
  transfer_pair_id?: id,      # double écriture transfert
  status: posted|pending|void,
  source: manual|import|grocery_purchase|inventoria|correction,
  external_fingerprint?: str, # anti double-comptage import
  correction_of?: id,         # écriture corrective
  rev, idempotency_key?
}
```

### `recurring_payments`

`id`, `account_id`, `category_id`, `amount_cents`, `cadence`, `next_on`,
`auto_post: false` (v1 = rappel seulement sauf opt-in explicite), `rev`

### `budget_envelopes` (période)

`id`, `category_id`, `period_start`, `period_end`, `allocated_cents`,
`spent_cents_cached?` (dérivable ; cache invalidé par tx), `rev`

### `goals`

`id`, `name`, `target_cents`, `saved_cents`, `due_on?`, `account_id?`, `rev`

### `ledger_audit`

Append-only : `{id, at, actor, action, entity_type, entity_id, before?, after?, reason}`

---

## Repas & Épicerie

### `diet_profiles`

`id`, `household_id`, `label`, `allergens[]`, `dislikes[]`, `calorie_target?`,
`prefs: {vegetarian, vegan, halal, kosher, …}`

### `products`

```
product {
  id, name, brand?,
  barcode?: str,                 # EAN/UPC normalisé
  canonical_unit: g|ml|each,
  default_qty_milli: int,
  category_tags[],
  inventory_item_id?: "itm-…",   # lien optionnel
  rev
}
```

### `unit_equivalences`

`product_id?` (null = global), `from_unit`, `to_unit`, `factor_milli`, `rev`

### `food_lots`

```
food_lot {
  id, product_id,
  item_id?: "itm-…",             # lien inventaire HQ
  place_id?: "plc-…",
  qty_milli: int,
  canonical_unit,
  expires_on?: "YYYY-MM-DD",
  usable_qty_milli: int,         # ≤ qty_milli
  opened_on?, source_purchase_id?,
  rev
}
```

### `merchants`

`id`, `name`, `location_label?`, `provider_id?`, `rev`

### `price_offers`

Voir [05-price-providers.md](05-price-providers.md) — schéma `price_offer.v1`.

### `recipes`

```
recipe {
  id, title, servings: int,
  ingredients: [{product_id?, name, qty_milli, unit, optional, substitutes[]}],
  steps: str[],
  leftover_policy: none|freeze|plan_next,
  rev
}
```

### `meal_plans`

`id`, `period_start`, `period_end`, `slots: [{date, meal: breakfast|lunch|dinner|snack, recipe_id?, notes?}]`, `rev`

### `grocery_lists`

`id`, `meal_plan_id?`, `status: open|shopping|closed`,
`lines: [{product_id?, name, qty_milli, unit, merchant_id?, estimated_cents?, checked}]`, `rev`

### `planned_purchases` / `actual_purchases`

```
planned_purchase { id, list_id, product_id?, qty_milli, unit, offer_id?, estimate_cents }
actual_purchase {
  id, planned_id?, product_id?, merchant_id,
  qty_milli, unit, paid_cents, taxed_cents, deposit_cents,
  purchased_on, fingerprint, finance_tx_id?, food_lot_id?,
  idempotency_key, rev
}
```

---

## Inventoria

### `inventoria_sessions`

```
session {
  id: "ivo-<16hex>",
  device_id, owner,
  created_at, updated_at,
  status: open|closed,
  messages: [{role: user|assistant|system, text, at}],  # borne max
  # Distinct de Transferania / Else threads
}
```

### `inventoria_operations`

```
operation {
  id,
  session_id,
  status: draft|validated|previewed|committing|committed|needs_reconcile|cancelled|failed,
  proposals: Proposal[],          # structured, never free text as write source
  validation?: ValidationReport,
  preview?: PreviewDiff,
  commit?: CommitResult,
  idempotency_key,
  expected_inventory_rev?: int,   # store rev snapshot
  item_rev_expectations: [{item_id, rev}],
  audit: AuditEvent[],
  created_at, updated_at
}
```

### `Proposal` (structured)

```
{
  op: item.adjust|item.create|item.update|item.move|item.delete|place.create|…,
  refs: { item_id?, place_id?, name_hint? },
  resolved: { item_id?, place_id?, confidence: high|medium|low },
  payload: { … mirrors hq_inventory.apply fields … },
  label_fr: str
}
```

Résolution des références : matching déterministe sur ids / codes place / score
nom ; `confidence: low` → exige confirmation UI avant preview.

---

## Invariants non négociables

1. Soldes financiers = arithmétique entière sur centimes.
2. `usable_qty_milli ≤ qty_milli`.
3. `actual_purchase.fingerprint` unique par foyer (anti double-comptage).
4. Commit Inventoria sans `idempotency_key` → refusé.
5. Aucune proposition Inventoria n'écrit tant que `status < committing`.
6. Lien `item_id` doit matcher `ITEM_RE` de `hq_inventory` ; id inconnu → 404
   métier, pas de création silencieuse sauf proposal `item.create` confirmée.
