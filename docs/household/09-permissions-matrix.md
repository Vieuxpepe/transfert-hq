# Matrice de permissions (household)

Rôles HQ actuels : `admin` | `upload`. CSRF requis sur toute mutation cookie.

Légende : **R** lecture · **W** écriture · **—** 403 · **C** CSRF obligatoire

| Ressource | admin | upload |
|-----------|-------|--------|
| `GET /api/finances/*` | R | — |
| `POST /api/finances/*` | W+C | — |
| `GET /api/grocery/*` | R | — |
| `POST /api/grocery/*` | W+C | — |
| `GET /api/meals/*` | R | — |
| `POST /api/meals/*` | W+C | — |
| `GET /api/inventoria/*` | R | — |
| `POST /api/inventoria/*` | W+C | — |
| `GET/POST /api/inventory` (existant) | R/W+C | — |
| Export CSV finances (futur) | W+C | — |
| Import offres prix | W+C | — |
| Provider auto flyer (futur) | W+C + flag config | — |
| Envoi ledger → LLM | **interdit** (aucun rôle) | — |
| Commit inventaire via Inventoria | W+C admin | — |
| Mutation budget via Inventoria | **interdit** (passer par finances UI) | — |
| Vues nav Finances / Repas | admin session | masqué |
| FAB Inventoria | admin | masqué |
| Transferania / Else | inchangé | inchangé |

## Capacités fines (futur, si multi-utilisateur élargi)

v1 = single admin household. Si rôles enrichis plus tard :

| Capacité | Description |
|----------|-------------|
| `finances.read` | Voir soldes |
| `finances.write` | Poster tx |
| `finances.correct` | Écritures correctives |
| `grocery.write` | Listes / achats |
| `inventoria.commit` | Commit mutations inventaire |
| `prices.import` | Import offres |

Ne pas implémenter avant besoin réel — la matrice admin/upload suffit pour #30+.
