# Phase 3 — Contrats d'intégration API

Tous les préfixes futurs : **admin-only** (hors `UPLOAD_*`), CSRF fail-closed
sur mutations, JSON `{ok|error, code, …}`. Aucune route n'est branchée dans PR #30.

Erreurs stables (à ajouter plus tard à `docs/hq-error-codes.md`) :

| code | HTTP | Sens |
|------|------|------|
| `validation_error` | 400 | Schéma / champs |
| `forbidden` | 403 | Rôle |
| `not_found` | 404 | Entité |
| `conflict` | 409 | `rev` / fingerprint / idempotency mismatch |
| `needs_reconcile` | 409 | Cross-store partiel |
| `quota` | 507 | Limites |
| `storage_error` | 503 | SQLite / disque |
| `not_implemented` | 501 | Provider prix non configuré |

Limites v1 (proposées) : body ≤ 1 Mo ; list pages ≤ 200 ; inventoria proposals ≤ 20 / op ;
sessions messages ≤ 100 ; idempotency_key TTL 72 h.

---

## `/api/finances/*`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/finances/summary` | admin | Soldes + enveloppes période courante |
| GET | `/api/finances/accounts` | admin | Liste comptes |
| POST | `/api/finances/accounts` | admin+CSRF | Créer / update (`rev`) |
| GET | `/api/finances/categories` | admin | Catégories |
| POST | `/api/finances/categories` | admin+CSRF | CRUD catégories |
| GET | `/api/finances/transactions` | admin | Filtre `from,to,account,category,cursor` |
| POST | `/api/finances/transactions` | admin+CSRF | Créer tx (`amount_cents`, `idempotency_key`) |
| POST | `/api/finances/transactions/correct` | admin+CSRF | Écriture corrective liée |
| POST | `/api/finances/transfers` | admin+CSRF | Paire double-écriture |
| GET | `/api/finances/envelopes` | admin | Budgets période |
| POST | `/api/finances/envelopes` | admin+CSRF | Allouer |
| GET | `/api/finances/recurring` | admin | Récurrences |
| POST | `/api/finances/recurring` | admin+CSRF | CRUD ; `auto_post` défaut false |
| GET | `/api/finances/goals` | admin | Objectifs |
| POST | `/api/finances/goals` | admin+CSRF | CRUD |
| GET | `/api/finances/audit` | admin | Journal (pas de montants complets en logs serveur) |

**Validation :** `amount_cents` int strict (bool refusé) ; `booked_on` ISO date ;
transfert = deux legs opposées même `transfer_pair_id`.

**IA :** aucun endpoint ne pousse le ledger vers un modèle. Summaries UI locales.

---

## `/api/grocery/*`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/api/grocery/products` | admin | Catalogue + barcode lookup |
| GET/POST | `/api/grocery/lots` | admin | Lots ; lien `item_id` |
| GET/POST | `/api/grocery/merchants` | admin | Commerces |
| GET/POST | `/api/grocery/offers` | admin | Offres (manuel / import) |
| POST | `/api/grocery/offers/import` | admin+CSRF | Import fichier validé |
| GET/POST | `/api/grocery/lists` | admin | Listes d'épicerie |
| POST | `/api/grocery/purchases/planned` | admin+CSRF | Achats prévus |
| POST | `/api/grocery/purchases/actual` | admin+CSRF | Achats réels → option tx + lot |
| GET | `/api/grocery/price-history` | admin | Historique prix produit |

`POST .../purchases/actual` body (extrait) :

```json
{
  "planned_id": null,
  "product_id": "prd-…",
  "merchant_id": "mch-…",
  "qty_milli": 1000000,
  "unit": "g",
  "paid_cents": 349,
  "taxed_cents": 17,
  "deposit_cents": 0,
  "purchased_on": "2026-11-09",
  "fingerprint": "mch|prd|2026-11-09|349|1000000",
  "idempotency_key": "…",
  "post_finance": true,
  "create_lot": true,
  "link_item_id": "itm-…"
}
```

Si `post_finance` + `create_lot` + éventuel `item.adjust` : journal de
réconciliation (voir architecture).

---

## `/api/meals/*`

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET/POST | `/api/meals/profiles` | admin | Profils alimentaires |
| GET/POST | `/api/meals/recipes` | admin | Recettes / substitutions |
| GET/POST | `/api/meals/plans` | admin | Plans de repas |
| POST | `/api/meals/plans/{id}/build-list` | admin+CSRF | Génère grocery list (preview puis commit) |
| POST | `/api/meals/leftovers` | admin+CSRF | Enregistrer reste → lot |

---

## `/api/inventoria/*`

Architecture **propose → validate → preview → commit → audit**.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/inventoria/sessions` | admin+CSRF | Ouvrir session |
| GET | `/api/inventoria/sessions/{id}` | admin | Historique borné |
| POST | `/api/inventoria/sessions/{id}/message` | admin+CSRF | Tour user → draft proposals |
| POST | `/api/inventoria/ops/{id}/validate` | admin+CSRF | Résoudre refs, règles |
| POST | `/api/inventoria/ops/{id}/preview` | admin+CSRF | Diff + `expected_rev` |
| POST | `/api/inventoria/ops/{id}/commit` | admin+CSRF | Exige `idempotency_key` |
| POST | `/api/inventoria/ops/{id}/cancel` | admin+CSRF | Annule avant commit |
| GET | `/api/inventoria/ops/{id}` | admin | État + audit |
| POST | `/api/inventoria/ops/{id}/reconcile` | admin+CSRF | Reprendre `needs_reconcile` |

### Commit — contrat

```json
{
  "idempotency_key": "ivo-op-…",
  "expected_inventory_rev": 42,
  "item_rev_expectations": [{"item_id": "itm-…", "rev": 3}]
}
```

- Même clé + même body → retourne le `CommitResult` original (idempotent).
- Même clé + body différent → **409** `conflict`.
- `item.update|delete` : respecter `rev` inventaire ; `item.adjust` : delta sans
  rev item, mais `expected_inventory_rev` store recommandé.
- Échec partiel → `needs_reconcile` + plan ; **pas** de retry aveugle.

### Interdit

- Endpoint qui applique du JSON LLM brut à `hq_inventory.apply`.
- Fusion des threads Transferania / Else / Inventoria.
- Auto-commit budget depuis Inventoria (finances = confirmation séparée).

---

## Intégration bridge (future PR d'activation)

1. Ajouter handlers minces (pattern `/api/inventory`).
2. Ligne dans `docs/hq-api-route-index.md`.
3. Tests CSRF + rôle upload → 403.
4. Ne pas ajouter aux `UPLOAD_POST_*`.
