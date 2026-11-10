# Phase 6 — Architecture d'interface

**PR #30 : aucune modification de navigation live.** Ce document fige le plan.

## Onglets principaux (futurs)

### Finances — `data-nav="finances"` / view `finances`

Sous-vues (tabs internes, une job / section) :

| Sous-vue | Job unique |
|----------|------------|
| Vue générale | Soldes + alertes enveloppes |
| Transactions | Liste / saisie / correction |
| Budgets | Enveloppes période |
| Factures | Récurrences à venir |
| Objectifs | Progression `saved/target` cents |
| Analyses | Agrégats locaux (sans LLM) |

Lazy-load : `assets/hq-finances*.js` (pattern Carnet/Forge).

### Repas & Épicerie — `data-nav="repas"` / view `repas`

| Sous-vue | Job unique |
|----------|------------|
| Planificateur | Meal plan |
| Circulaires | Offres + fraîcheur |
| Recettes | CRUD recettes |
| Liste d'achats | Grocery list active |
| Garde-manger | Lots + expirations (+ lien inventaire) |
| Historique des prix | Courbes / table unitaires |

Lazy-load : `assets/hq-meals.js`, `assets/hq-grocery.js`.

### Placement nav

Bottom-nav déjà saturée. Séquence recommandée :

1. Entrées sous **Plus / Système** (activation soft).
2. Promotion onglets principaux quand les modules sont stables.
3. Inventaire existant reste ; Garde-manger **ne remplace pas** Inventaire.

---

## Inventoria — FAB global

Spécification normative : **[14-inventoria-ux.md](14-inventoria-ux.md)**
(safe areas, ouverture simultanée, focus, clavier, petit écran). **Aucun**
changement de navigation dans PR #30.

```
┌─────────────────────────────────────────┐
│  view content                           │
│                                         │
│  [Inventoria FAB]          [Else chip]  │
│   bas-gauche                / Transferania
│                             bas-droite  │
│  ─────────────────────────────────────  │
│              bottom-nav                 │
└─────────────────────────────────────────┘
```

| Règle | Détail |
|-------|--------|
| Ancrage | Bas-**gauche**, `bottom: calc(var(--nav-h) + gap)` |
| z-index | ≤ 310 (sous Transferania 320 et AI ~330) |
| Mobile | FAB 48–56 px ; panneau full-height sheet, pas d'overlay opaque sur les chips sœurs |
| Panneau | Conversation + **PreviewDiff** sticky (avant/après) |
| Confirm | Boutons Valider / Annuler explicites ; pas de swipe-to-commit |
| Coexistence | Ne pas déplacer Transferania/Else ; hit-test isolé ; `pointer-events` contenus |

États UI Inventoria : `idle → chatting → proposals → preview → committing → done/error/reconcile`.

---

## Accessibilité / perf

- 375 px d'abord (convention HQ).
- Pas de Live2D pour Inventoria (persona légère, texte + icône).
- Préchargement scripts seulement à l'ouverture du panneau / onglet.
