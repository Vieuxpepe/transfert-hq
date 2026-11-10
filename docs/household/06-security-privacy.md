# Phase 5 — Sécurité et confidentialité

Spécification normative élargie : **[13-financial-security.md](13-financial-security.md)**
(ACL fichiers, rétention, allowlist Inventoria→LLM, écritures ledger).

## Local-first

- Données ménage sur le PC HQ (`.hq-household/`), pas de sync cloud dans le
  design v1.
- Clés API LLM : restent dans la config bridge existante ; **jamais** sérialisées
  dans les exports household.

## Contrôle d'accès

- Mutations finances / grocery / meals / inventoria : **admin** + CSRF Origin/Referer.
- Rôle `upload` : **aucun** accès lecture/écriture household (403).
- Pas de nouvel élargissement `UPLOAD_*` pour ces préfixes.

## IA — clôtures

| Interdit | Mitigation |
|----------|------------|
| Envoyer IBAN / numéros de carte / relevés bruts au LLM | Redaction + scopes ; inventoria/finances prompts = libellés + centimes agrégés seulement si l'utilisateur l'autorise explicitement |
| Modification budget depuis une réponse modèle | Toute écriture ledger = action UI/API confirmée |
| Write inventaire depuis JSON LLM brut | Pipeline inventoria |
| Fusion mémoire sœurs | Stores sessions séparés |

Défaut recommandé : Inventoria reçoit **contexte inventaire** (noms, qty, places)
mais **pas** le ledger financier. Croisement budget = outils UI séparés.

## Double-comptage et corrections

- `fingerprint` + `idempotency_key` sur achats réels et tx.
- Corrections = nouvelles écritures `correction_of` (append-only), pas d'édition
  silencieuse de l'historique posté.
- `void` marque sans effacer l'audit.

## Journalisation

- Logs bridge : pas de dump de `amount_cents` listes ; codes + ids suffisent.
- Diag packets : exclure tables transactions détaillées par défaut.
- Fichiers import : permissions dossier `.hq-household/imports` restreintes
  (ACL Windows si dispo, pattern forge/agent-state).

## Sauvegardes & migrations

Voir [08-migrations-backup.md](08-migrations-backup.md).

- Pas de migration automatique d'anciens fichiers d'inventaire hors contrat
  `hq_inventory`.
- Restore testable avant toute activation runtime.

## Surface d'attaque API

- Bornes taille body / pagination.
- Validation stricte ids (`ITEM_RE` etc.).
- Idempotency store borné (TTL + purge).
