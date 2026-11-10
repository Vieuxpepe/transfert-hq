# Phase 1 — Audit des fondations existantes

Audit lu sur `main` @ `5ea711b` (merge PR #29). **Aucune modification des
modules audités** pour contourner leurs contrats.

---

## 1. `hq_inventory.py`

| Contrat | Réalité |
|---------|---------|
| Stockage | JSON atomique `.hq-inventory/inventory.json` (dossier + fichier + lock dédiés) |
| Version doc | `version: 1` fixe ; `rev` global + `rev` par place/item |
| IDs | `plc-<16 hex>`, `itm-<16 hex>` (regex strictes) |
| Quantités | Entiers `0..QTY_MAX` ; unité string libre ≤16 chars (pas de table d'unités) |
| Mutations | Une action / écriture via `apply()` |
| Actions | `place.*`, `item.create|update|adjust|delete|move|restore` |
| Conflits | Update/delete exigent `rev` exact → **409** + enregistrement courant |
| Exception | `item.adjust` et `item.move` **n'exigent pas** de `rev` (deltas / bulk) |
| Échec stockage | Fichier malformé / redirigé (symlink/junction) → **503**, octets intacts |
| Photos | Références Carnet `asset-<24 hex>` uniquement |
| Limites | 2000 places, 10000 items, profondeur 8, bulk move ≤500 |

### Limites pour Inventoria / Garde-manger

1. **Pas de champs alimentaires** (expiration, lot, code-barre, qty fractionnaire).
   Les lots repas doivent vivre dans un store household et **référencer** `item_id`.
2. **Unités non canoniques** : `"pcs"`, `"g"`, `"L"` sont des chaînes libres —
   pas de conversion. Household définit ses propres unités + table d'équivalence.
3. **Pas d'idempotence** : rejouer `item.adjust` double le delta. Inventoria doit
   porter une `idempotency_key` côté household avant d'appeler `apply`.
4. **Pas de multi-écriture atomique** avec un autre store (SQLite / finances).
5. **Pas de migration automatique** d'anciens inventaires : volontaire — ne pas
   en inventer pour le ménage.
6. Contournement interdit : ne pas étendre `_ITEM_KEYS` pour y coller l'épicerie.

---

## 2. `hq_ai.py` — propose → confirm

Flux « Noter » existant :

```
capture(text) → LLM JSON → normalize() → proposals[]
apply(proposals) → re-normalize → apply_one → module métier
```

| Point fort | Limite pour Inventoria |
|------------|------------------------|
| Rien n'est écrit avant confirmation | Pas de preview structuré multi-étapes (validate / preview / commit) |
| `normalize` rejoué à `apply_one` | Pas de session conversationnelle dédiée inventaire |
| Stock → `item.adjust` / `item.create` | Pas d'idempotence ; pas d'audit trail household |
| Max 3 actions / capture | Inventoria aura des lots plus larges → batch + preview |
| Contexte inventaire tronqué (~80 items) | Résolution de références doit être un service dédié |
| Threads Transferania / Else séparés | Inventoria = 3ᵉ canal ; ne pas fusionner les stores mémoire |

**Règle retenue :** Inventoria **réutilise le pattern** propose→confirm, mais
avec un pipeline **propose → validate → preview → commit → audit** dans
`hq_inventoria` (futur), sans écrire depuis la réponse LLM brute.

---

## 3. `hq_state.py`

| Contrat | Réalité |
|---------|---------|
| API | `write_json_atomic(path, data)` + `path_lock` |
| Garantie | tmp + fsync + `os.replace` ; JSON invalide existant → refuse d'écraser |
| Scope | Fichiers JSON HQ ; secrets compagnon sous `.hq-agent-state/` |
| Migration | Déplacement one-shot legacy agent → `.hq-agent-state` (fail-closed si double) |

### Limites

- Pas de SQLite, pas de multi-fichier transactionnel.
- Household finances / repas → **SQLite dédié** (volume, requêtes, audit) ;
  métadonnées légères peuvent rester JSON via `write_json_atomic`.
- Inventory JSON reste sur son propre chemin ; croisement = **réconciliation
  explicite**, jamais une fausse atomicité cross-store.

---

## 4. `iphone_bridge.py`

| Domaine | Contrat actuel |
|---------|----------------|
| Auth | Session cookie ; rôles `admin` \| `upload` |
| CSRF | Fail-closed Origin/Referer sur POST/PUT/PATCH/DELETE (+ logout GET) |
| Upload role | Allowlist stricte `UPLOAD_GET_*` / `UPLOAD_POST_*` ; hors liste → 403 |
| Inventaire | `GET/POST /api/inventory` — **admin only** (hors allowlist upload) |
| AI | `GET/POST /api/ai` — admin ; actions `ask` / capture / companions |
| Nav bottom | Accueil, Intime, Carnet, Calendrier, Dessiner, Forge, Fichiers, Projets, Inventaire, Lecteur, Terminal, Plus |
| Lazy views | Carnet / Forge déjà lourds ; futurs onglets devront lazy-load |

### Limites pour household

1. Bottom-nav déjà dense → Finances / Repas passent d'abord par **Plus** ou
   sous-routes ; promotion en onglet principal = PR UI dédiée (hors #30).
2. Nouveau préfixe API = entrée Handler + ligne dans `hq-api-route-index.md` +
   tests smoke CSRF/rôle.
3. Ne pas élargir le rôle `upload` aux finances / inventoria.

---

## 5. Interfaces compagnon (coexistence)

| Surface | Implémentation | z-index / ancrage |
|---------|----------------|-------------------|
| Transferania | `assets/hq-companion.js` + Live2D | `.hq-companion` fixed **z-index 320**, coin bas-droit au-dessus de `--nav-h` |
| Else chip | `assets/hq-else-chip.js` + CSS dans `hq-companion.css` | Chip flottant sœur ; ne pas fusionner mémoire / threads |
| Assistant « Noter » | `#btn-ai` + panneau AI | Au-dessus des compagnons (`.ai-back` ~330) |
| Inventoria (futur) | FAB + panneau | Doit **éviter** le dock compagnon ; slot bas-gauche ou rail dédié (voir UI) |

### Limites

- Deux flottants + un futur FAB = collision tactile mobile. Inventoria ne doit
  ni masquer Transferania/Else, ni voler leurs hit-targets.
- Threads / prefs / archive SQLite compagnon restent séparés ; Inventoria a son
  propre store de sessions (voir modèles).

---

## 6. Synthèse — ce qu'on ne contourne pas

| Interdit | Alternative household |
|----------|----------------------|
| Étendre `_ITEM_KEYS` pour l'épicerie | Table `food_lots` → `item_id` |
| Écrire l'inventaire depuis le LLM | Pipeline inventoria commit |
| Transaction magique SQLite↔JSON | Journal de réconciliation + états `pending/committed/compensated` |
| Migrer auto d'anciens inventaires | Refuse + doc opérateur |
| Floats pour l'argent | Centimes `INTEGER` |
| Scraping circulaire « parce que site » | Provider interface + manuel |
