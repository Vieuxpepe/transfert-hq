# Household Intelligence — fondations (PR #30)

Index des livrables d'architecture pour **Finances**, **Repas & Épicerie** et
**Inventoria**. Aucun runtime actif dans cette PR : contrats, schémas, plans.

| Document | Contenu |
|----------|---------|
| [01-audit-foundations.md](01-audit-foundations.md) | Limites des contrats existants (`hq_inventory`, `hq_ai`, `hq_state`, bridge, compagnons) |
| [02-architecture.md](02-architecture.md) | Vue d'ensemble, diagrammes de flux, décisions de stockage |
| [03-data-models.md](03-data-models.md) | Modèles versionnés (argent en centimes, unités canoniques) |
| [04-api-contracts.md](04-api-contracts.md) | Espaces `/api/finances|grocery|meals|inventoria/*` |
| [05-price-providers.md](05-price-providers.md) | Interface fournisseurs de prix + saisie manuelle |
| [06-security-privacy.md](06-security-privacy.md) | Local-first, CSRF, IA, journalisation, sauvegardes |
| [07-ui-architecture.md](07-ui-architecture.md) | Onglets futurs + FAB Inventoria vs Transferania / Else |
| [08-migrations-backup.md](08-migrations-backup.md) | Migrations non destructives + restauration testable |
| [09-permissions-matrix.md](09-permissions-matrix.md) | Rôles `admin` / `upload` × routes |
| [10-test-strategy.md](10-test-strategy.md) | Tests, erreurs, idempotence, réconciliation |
| [11-incremental-pr-plan.md](11-incremental-pr-plan.md) | Plan de PR incrémentales + critères d'acceptation |
| [12-cross-store-journal.md](12-cross-store-journal.md) | **A** — Journal SQLite↔JSON, idempotence, crash, reconcile |
| [13-financial-security.md](13-financial-security.md) | **B** — ACL fichiers, backups, allowlist Inventoria→LLM |
| [14-inventoria-ux.md](14-inventoria-ux.md) | **C** — FAB bas-gauche, safe areas, focus/clavier (sans nav #30) |

**Schémas versionnés :** [`schemas/household/`](../../schemas/household/)  
**Validateurs stdlib :** [`hq_household_schemas.py`](../../hq_household_schemas.py)  
**Tests :** `python -m unittest tests.test_household_schemas -v`

Branche de travail : `feat/household-foundations` (depuis `main` post-PR #29).  
Hors scope : fusion, déploiement, navigation live, persona déployée, collecte auto de circulaires.

Accord de principe architecture : oui — exigences A/B/C documentées ci-dessus avant implémentation.
