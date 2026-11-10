# B — Sécurité financière

Complète et précise [06-security-privacy.md](06-security-privacy.md).
Aucune écriture ledger sans validation **et** autorisation serveur.

---

## 1. Permissions fichiers (runtime futur)

Racine : `<ROOT>/.hq-household/`

| Chemin | Contenu | ACL / mode cible |
|--------|---------|------------------|
| `household.sqlite` (+ WAL/SHM) | Ledger, grocery, inventoria ops | Owner-only (Windows DACL utilisateur du bridge ; Unix `0600` / dir `0700`) |
| `schema_meta.json` | Version schéma | Même ACL |
| `backups/` | Snapshots cohérents | Même ACL ; pas de share réseau |
| `imports/` | CSV/JSON prix ou relevés | Même ACL ; purge manuelle |
| `exports/` (futur) | Exports opt-in | Même ACL ; TTL court |

Règles :

- Création dossier via helper dédié (pattern `.hq-agent-state` / forge) — pas de
  umask permissif.
- Refus symlink/junction sur le dossier household (aligné `hq_inventory.confined_path`).
- Process bridge = seul writer ; pas de lecture depuis workers non fiables.

Inventaire JSON reste sous `.hq-inventory/` avec son propre confinement existant.

---

## 2. Sauvegarde / restauration / rétention

| Politique | Valeur v1 |
|-----------|-----------|
| Avant migration schéma | Snapshot obligatoire (voir [08-migrations-backup.md](08-migrations-backup.md)) |
| Backup périodique | Inclus dans `backup_dir` HQ **quand** runtime activé ; manifeste `{schema, inventory_rev?, sha256, taken_at}` |
| Rétention snapshots locaux `.hq-household/backups/` | 14 derniers **ou** 30 jours (le plus restrictif gagne) |
| Rétention `cross_store_ops` terminales | 90 jours (métadonnées) ; payloads volumineux compactés après 14 jours |
| Rétention idempotency keys | ≥ 72 h après terminal |
| Audit ledger (`ledger_audit`) | Append-only ; rétention 2 ans ou indefinitely local (choix opérateur) |
| Imports | Conservés 30 jours puis suggestion purge UI |
| Restore | Uniquement vers ROOT jetable d'abord ; promote manuel |

**Confidentialité backup :** les archives household sont des données sensibles —
ne pas les coller dans tickets / agent packets / logs diag par défaut.

---

## 3. Politique de confidentialité (données ménage)

1. **Local-first** : pas de sync cloud dans le design v1.
2. **Minimisation logs** : ids + `code` d'erreur ; pas de listes `amount_cents`,
   payees, ou IBAN dans stdout/JSONL diag.
3. **Packets agent** (`/api/diag/*`) : exclure tables `transactions`,
   `actual_purchases`, `ledger_audit` détaillées sauf flag opérateur explicite
   `include_household_finance=1` (futur, défaut off).
4. **Exports** : action UI admin + CSRF ; fichier local ; pas d'upload auto.
5. **IA** : voir §4 — allowlist stricte.

---

## 4. Ce qu'Inventoria peut envoyer à un modèle externe

Inventoria utilise le stack LLM HQ existant (clés locales). **Allowlist prompt** :

| Autorisé (défaut) | Interdit (toujours) |
|-------------------|---------------------|
| Noms d'items / places inventaire | Numéros de compte, IBAN, cartes, CVV |
| Quantités, unités, codes place | Relevés bancaires bruts / CSV import finance |
| Tags, notes item non financières | `amount_cents`, soldes, enveloppes, goals |
| Intentions user (« j'ai fini le lait ») | Fingerprints d'achat, payees, mémos tx |
| Proposals structurées déjà normalisées (sans prix) | Historique `ledger_audit` |
| Ids `itm-` / `plc-` nécessaires à la résolution | Tout fichier sous `.hq-household/imports` finance |

**Opt-in explicite (futur flag prefs, défaut `false`)** : résumés budgétaires
agrégés (`catégorie → total_cents` sur période) — jamais ligne à ligne, jamais
identifiants bancaires. Même opt-in **ne** permet **pas** à Inventoria d'écrire
le ledger.

Chaîne obligatoire côté serveur avant `generate()` :

1. Construire contexte depuis allowlist.
2. Scrubber : regex / denylist champs finance.
3. Si scrubber retire >0 champs sensibles → log compteur seul (`redacted_fields=N`).

---

## 5. Aucune écriture financière sans validation + autorisation serveur

| Couche | Exigence |
|--------|----------|
| Auth | Session `admin` uniquement |
| CSRF | Origin/Referer fail-closed sur POST |
| Schéma | `hq_household_schemas` / validateurs domaine (centimes int, dates, ids) |
| Métier | Soldes dérivés ; corrections append-only ; `auto_post` récurrences défaut `false` |
| Inventoria | **Interdit** d'appeler `hq_finances` write — matrice permissions |
| Idempotence | Voir §5.1 |
| Double soumission | Même clé + même body → même tx id ; clé + body ≠ → 409 |

Toute écriture ledger passe par un handler finances qui :

1. Vérifie rôle + CSRF.
2. Valide payload (refus float/bool ; dates calendaires réelles).
3. Vérifie idempotency (§5.1).
4. Persiste + audit.
5. Retourne entité — **jamais** « le modèle a dit OK ».

### 5.1 Idempotence finances vs achats répétés légitimes

| Mécanisme | Portée | Comportement |
|-----------|--------|--------------|
| `idempotency_key` | Une **soumission client** (POST) | Même clé + même body normalisé → même `tx` / `purchase`. Même clé + body différent → **409**. Sources `import` / `grocery_purchase` : clé **obligatoire**. |
| `external_fingerprint` (tx) / `fingerprint` (purchase) | Une **ligne de relevé / ticket** | Bloque le double-comptage du même reçu. Doit inclure un discriminateur de ligne (index, `receipt_id`, …). |
| Achats répétés légitimes | Deux courses, même SKU | **Deux** fingerprints distincts + **deux** clés d'idempotence. Ce n'est pas un conflit. |

---

## 6. Cohérence schémas / validateurs / tests

| Artefact | Rôle |
|----------|------|
| `schemas/household/finances.v1.json` | Contrat documentaire |
| `hq_household_schemas.validate_transaction` etc. | Enforce runtime (et #30) |
| `tests/test_household_schemas.py` | Conformité centimes, ids, refus float |
| Futur `tests/test_hq_finances_security.py` | CSRF, upload 403, redaction prompt, ACL fichier |

Invariants pinés dès #30 :

- `require_cents` refuse `float` / `bool` / `str`
- transaction / purchase / price_offer validés sur fixtures
- pipeline inventoria sans write finance dans le contrat doc + code comments

Toute divergence schéma JSON ↔ validateur Python = bug bloquant merge runtime.
