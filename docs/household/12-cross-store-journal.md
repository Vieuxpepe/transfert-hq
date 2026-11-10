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
| `request_hash` | text | SHA-256 canonique du body normalisé |
| `planned_steps` | JSON | Liste ordonnée d'étapes `{store, action, payload, expected_*}` |
| `step_index` | int | Prochaine étape à exécuter (0-based) |
| `step_results` | JSON | Résultats partiels (revs, qty before/after si connus) |
| `inventory_rev_before` | int? | Snapshot `doc.rev` avant toute écriture JSON |
| `inventory_rev_after` | int? | `doc.rev` observé après succès inventaire |
| `uncertain_inventory` | int 0/1 | **1** si un `item.adjust` a un résultat inconnu |
| `reconcile_plan` | JSON? | Actions humaines/serveur autorisées |
| `error_code` | text? | Dernier échec |
| `created_at` / `updated_at` | real | Epoch |
| `closed_at` | real? | Terminal |

### Machine d'états

```text
accepted
  → preparing          # steps figés, hash enregistré
  → applying_sqlite    # écritures SQLite non terminales
  → applying_inventory # appel(s) hq_inventory.apply
  → finalizing         # marquage SQLite terminal + audit
  → committed          # terminal OK

  ↘ needs_reconcile    # terminal soft : reprise manuelle/API reconcile
  ↘ failed             # terminal : rien d'incertain côté inventaire
  ↘ cancelled          # terminal : annulé avant applying_inventory
```

Transitions interdites :

- `committed` → quoi que ce soit (immuable).
- `needs_reconcile` → `applying_inventory` **sans** passage `reconcile` explicite.
- Rejouer une étape `item.adjust` si `uncertain_inventory = 1`.

---

## 2. Clés d'idempotence

| Champ | Règle |
|-------|-------|
| Format | 8–128 chars ; recommandation `ivo-{op_id}-{attempt}` ou UUID |
| Portée | Unique dans `cross_store_ops.idempotency_key` **et** tables filles (`transactions`, `actual_purchases`, inventoria ops) selon domaine |
| TTL | 72 h minimum en table ; purge après terminal + rétention audit |
| Même clé + même `request_hash` | Retourne le résultat / état déjà connu (**pas** de re-exécution) |
| Même clé + `request_hash` différent | **409** `conflict` — jamais d'écrasement |
| Clé absente sur mutation cross-store | **400** `validation_error` |

`request_hash` = SHA-256 d'un JSON canonique (clés triées, sans champs volatils
`collected_at` client). Le serveur recalcule ; le client ne fait pas foi.

---

## 3. Frontières d'écriture et récupération crash

Ordre canonique d'une op inventaire-touchante :

```text
F0  INSERT op status=accepted + idempotency_key + request_hash
F1  UPDATE preparing + planned_steps figés
F2  SQLite domain writes (lots/tx drafts) status=applying_sqlite
F3  BEFORE inventory: status=applying_inventory, inventory_rev_before=snapshot
F4  hq_inventory.apply(step) — une étape à la fois
F5  record step_results (rev item, qty si renvoyés)
F6  SQLite finalize + status=committed
```

| Crash entre | État au redémarrage | Récupération |
|-------------|---------------------|--------------|
| F0–F1 | `accepted` / `preparing` sans effets métier | Reprendre prepare **ou** `cancelled` si TTL soft |
| F1–F2 | `preparing` | Rejouer prepare idempotent (steps déjà hashés) |
| F2–F3 | `applying_sqlite` | Reprendre steps SQLite idempotents ; **ne pas** appeler inventaire |
| F3–F4 | `applying_inventory`, aucun step_result | Comparer `inventory_rev` courant vs `inventory_rev_before` |
| pendant F4 | `applying_inventory`, step en cours | Voir §4 (incertitude adjust) |
| F4 ok / F5 incomplet | step_results partiels | Continuer steps restants si certains |
| F5–F6 | inventaire OK, SQLite non finalisé | Finaliser SQLite uniquement (pas de re-apply inventaire) |

Routine boot (future) : scanner `status IN (preparing, applying_sqlite, applying_inventory, finalizing)` →
construire `reconcile_plan` ou avancer seulement les transitions **sûres**.

---

## 4. `item.adjust` — interdiction de rejeu aveugle

`hq_inventory.item.adjust` est un **delta sans rev item**. Si le processus meurt
après l'appel et avant d'enregistrer le résultat :

1. Marquer `uncertain_inventory = 1`, `status = needs_reconcile`.
2. **Ne jamais** rejouer le même delta automatiquement.
3. `reconcile_plan` propose uniquement :
   - `inspect` : lire qty/rev courants ;
   - `confirm_already_applied` : opérateur affirme que le delta est passé → finaliser sans apply ;
   - `confirm_not_applied` : opérateur affirme l'absence → **un seul** apply autorisé avec **nouvelle** sous-clé d'idempotence `…:adjust-retry-1` et journal explicite ;
   - `abort_compensate` : compensation SQLite seulement (pas d'inventaire).
4. Les ops `item.update` / `item.delete` / `place.*` avec `rev` : en cas de 409,
   pas d'incertitude delta — `needs_reconcile` avec payload conflit courant.

Heuristique **interdite** : « rev store a bougé ⇒ adjust déjà appliqué » (d'autres
clients peuvent avoir écrit). Seule la confirmation humaine/API reconcile compte.

---

## 5. Conflits de révision, reprise, réconciliation contrôlée

| Signal | HTTP / code | Comportement |
|--------|-------------|--------------|
| `expected_inventory_rev` ≠ courant **avant** F4 | 409 `conflict` | Pas d'écriture inventaire ; op → `failed` ou `needs_reconcile` selon politique |
| Item `rev` mismatch sur update/delete | 409 + record courant | Étape stop ; pas de steps suivants |
| Idempotency conflict | 409 `conflict` | Aucune mutation |
| `needs_reconcile` | 409 sur commit ; GET op OK | Seul `POST …/reconcile` avec action allowlistée avance |

Reprise (`resume`) : autorisée seulement si `uncertain_inventory = 0` et
prochaine étape non-adjust **ou** adjust jamais démarré (pas d'appel réseau inventaire enregistré).

---

## 6. Tests de crash et double soumission (spec d'implémentation future)

Fichier cible suggéré : `tests/test_household_cross_store.py` (PR #35/#36).

| ID | Scénario | Attendu |
|----|----------|---------|
| CS-01 | Double POST commit même `idempotency_key` + même body | 2ᵉ = même `CommitResult`, un seul apply inventaire |
| CS-02 | Même clé, body différent | 409 ; zéro 2ᵉ mutation |
| CS-03 | Crash après F3 avant F4 | Reboot → pas d'inventaire ; peut reprendre F4 une fois |
| CS-04 | Crash pendant `item.adjust` (injecté après apply mock sans log résultat) | `uncertain_inventory=1` ; reboot **ne** rappelle **pas** adjust |
| CS-05 | Crash après adjust OK avant finalize SQLite | Finalize SQLite only ; qty inventaire inchangée au 2ᵉ boot |
| CS-06 | 409 rev sur `item.update` mid-batch | steps suivants non exécutés ; reconcile |
| CS-07 | Deux commits parallèles deux clés, même item adjust | Tous deux appliqués (deltas) **ou** politique documentée de sérialisation ; journal distinct |
| CS-08 | `confirm_not_applied` puis retry adjust | Un apply ; sous-clé idempotente ; audit |

Les tests #30 ne simulent pas encore le runtime ; cette matrice est le contrat
d'acceptation des PRs d'implémentation.
