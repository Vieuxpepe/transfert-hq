# Format des fichiers `schemas/household/*.v1.json`

## Décision

Les sept fichiers `*.v1.json` sont des **descripteurs de contrat personnalisés
HQ** (`contract_format: "hq-custom-descriptor"`, `not_json_schema: true`).

Ils **ne sont pas** des schémas JSON Schema (Draft-04 / Draft-07 / 2020-12).
Ne pas les valider avec `jsonschema`, Ajv, ou `$schema` draft.

| Couche | Rôle |
|--------|------|
| `schemas/household/*.v1.json` | Documentation machine-lisible + concordance CI |
| `hq_household_schemas.py` | **Source de vérité enforceable** (stdlib) |
| `tests/test_household_schemas.py` | Conformité + concordance descripteur↔Python |

Fichiers attendus (exactement 7) :

1. `common.v1.json`
2. `cross_store_op.v1.json`
3. `finances.v1.json`
4. `grocery.v1.json`
5. `inventoria.v1.json`
6. `meals.v1.json`
7. `price_offer.v1.json`
