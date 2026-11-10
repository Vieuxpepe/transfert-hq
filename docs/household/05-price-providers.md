# Phase 4 — Fournisseurs de prix

## Principe

Aucune présomption qu'un site de circulaires expose une API publique ou autorise
la collecte automatisée. Le **premier provider livré** est manuel / import fichier.

```text
PriceProvider (interface)
  id, display_name, capabilities[],
  fetch_offers(query) -> OfferBatch | NotSupported
  normalize(raw) -> price_offer[]
  freshness(offer) -> fresh|stale|expired
```

---

## Schéma `price_offer` v1

```json
{
  "schema_version": 1,
  "id": "off-<16hex>",
  "merchant_id": "mch-…",
  "merchant_name": "string",
  "location_label": "string|null",
  "product_id": "prd-…|null",
  "product_name": "string",
  "barcode": "string|null",
  "price_cents": 349,
  "qty_milli": 1000000,
  "unit": "g",
  "unit_price_cents_per_canonical": 349,
  "promo": {
    "kind": "none|percent|bogo|multi|other",
    "label": "string",
    "conditions": "string"
  },
  "tax_included": false,
  "deposit_cents": 0,
  "collected_at": 0.0,
  "valid_from": "YYYY-MM-DD|null",
  "valid_to": "YYYY-MM-DD|null",
  "provenance": {
    "kind": "manual|file_import|provider",
    "provider_id": "manual|…",
    "source_label": "string",
    "verifiable": false,
    "raw_ref": "string|null"
  },
  "reliability": 0,
  "stale_after_days": 14,
  "rev": 1
}
```

`reliability` : 0–100 (manuel confirmé = 80 ; import non vérifié = 40 ;
provider automatisé futur = selon score).

`unit_price_cents_per_canonical` : entier calculé en arithmétique entière
(`price_cents * 1000 / qty_milli` avec règles d'arrondi documentées) — **pas**
de float stocké comme source de vérité.

---

## Providers prévus

| id | Statut | Notes |
|----|--------|-------|
| `manual` | v1 requis | Formulaire UI + collage |
| `file_csv` | v1 | Import CSV validé (colonnes bornées) |
| `file_json` | v1 | Import JSON conforme schéma |
| `flyer_*` | futur optionnel | Seulement si ToS / API / permission explicites |

Un provider non autorisé ou non configuré répond `501 not_implemented` —
jamais de fallback scraping silencieux.

---

## Fraîcheur

| État | Règle |
|------|-------|
| `fresh` | `now < valid_to` (si présent) et âge < `stale_after_days` |
| `stale` | Au-delà de `stale_after_days` mais encore affichable avec badge |
| `expired` | `now > valid_to` → exclu des suggestions d'achat auto |

Les listes d'épicerie peuvent figer `estimate_cents` au moment du plan pour
ne pas « bouger » sous les pieds du Master pendant les courses.

---

## Contrepartie manuelle (toujours disponible)

1. Saisie offre unitaire dans l'UI Circulaires.
2. Import CSV : `merchant,product,barcode,price_cents,qty_milli,unit,valid_to`.
3. Photo / note Carnet → saisie humaine (pas d'OCR auto obligatoire en v1).
