# Stratégie de tests et gestion des erreurs

## Couches

| Couche | Quand | Exemples |
|--------|-------|----------|
| Schémas | **PR #30** | `tests/test_household_schemas.py` |
| Domaine SQLite | PR finances/grocery | soldes entiers, fingerprints, migrations |
| Inventoria pipeline | PR inventoria | propose→…→commit, idempotence, reconcile |
| HTTP bridge | PR activation routes | CSRF, upload 403, codes erreur |
| UI | PR onglets / FAB | coexistence flottants, preview confirm |
| Chaos cross-store | PR inventoria+grocery | crash entre SQLite et `inventory.apply` |

## Invariants à pin (tests)

1. `amount_cents` refuse `float` / `bool` / str numériques ambiguës.
2. Solde = opening + Σ cents (fixture connue).
3. `fingerprint` dupliqué → 409, une seule tx.
4. Idempotency : même clé+body → même résultat ; clé+body≠ → 409.
5. Inventoria : draft n'appelle jamais `inventory_apply`.
6. Commit partiel → `needs_reconcile` ; retry sans reconcile refusé.
7. Migration v1→v2 sur DB fixture : données préservées.
8. Backup/restore round-trip smoke.
9. Upload role → 403 sur tous préfixes household.
10. Offre `expired` absente des suggestions.

## Gestion des erreurs (contrat client)

```json
{"error": "message fr", "code": "conflict", "rev": 12, "item": {…}}
```

Aligné sur `InventoryError` / `AiError`. Codes listés dans
[04-api-contracts.md](04-api-contracts.md).

UI : toast + rechargement entité sur 409 ; panneau reconcile sur
`needs_reconcile` ; pas de retry silencieux en boucle.

## PR #30 — tests livrés

```bash
python -m unittest tests.test_household_schemas -v
```

Couvre fixtures valides/invalides pour finances, grocery, meals, inventoria,
price_offer, journal cross-store (états / idempotence), et refus des floats
monétaires.

## Crash / double soumission (spec future)

Matrice **CS-01…CS-08** : [12-cross-store-journal.md](12-cross-store-journal.md) §6.
Fichier d'implémentation prévu : `tests/test_household_cross_store.py` (PR #35/#36).
Dont : **ne jamais** rejouer auto un `item.adjust` incertain (CS-04).

## Hors scope tests #30

Playwright nav, bridge routes, LLM — pas encore de surface runtime.
