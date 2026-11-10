# C — UX Inventoria (fondations UI)

**PR #30 : aucun changement de navigation live** (`iphone_bridge` bottom-nav,
`setView`, `data-nav` inchangés). Ce document fige le comportement pour les PRs
UI ultérieures (#37+).

Réf. coexistence : [07-ui-architecture.md](07-ui-architecture.md).

---

## 1. FAB bas-gauche

| Propriété | Valeur |
|-----------|--------|
| Ancrage | `position: fixed` ; `left: max(12px, env(safe-area-inset-left))` ; `bottom: calc(var(--nav-h, 64px) + 12px + env(safe-area-inset-bottom))` |
| Taille cible | 48×48 px (mobile) ; 56×56 px (desktop confort) |
| z-index | **300–310** (sous `.hq-companion` 320 et `.ai-back` ~330) |
| Hit area | ≥ 44×44 CSS px |
| Label a11y | `aria-label="Inventoria"` ; pas de titre qui vole le focus compagnon |

Transferania / Else restent **bas-droite**. Inventoria ne les déplace pas.

---

## 2. Zones de sécurité mobile

```text
┌──────────────────────────────────────────┐
│ safe-area-top                            │
│                                          │
│   contenu vue                            │
│                                          │
│  [FAB Inventoria]         [Else/Transf.] │
│   LEFT SAFE               RIGHT SAFE     │
│   ≥12px + FAB width       ≥12px + chip   │
│                                          │
│ ════════════ bottom-nav (nav-h) ════════ │
│ safe-area-bottom                         │
└──────────────────────────────────────────┘
```

| Zone | Règle |
|------|-------|
| `LEFT_SAFE` | Réservée FAB Inventoria + marge ; compagnons **ne** s'ancrent **pas** ici par défaut |
| `RIGHT_SAFE` | Réservée Transferania + Else chip ; panneau Inventoria ne doit pas y poser de contrôles primaires en mode compact |
| `NAV_CLEAR` | Aucun FAB / sheet peels under bottom-nav ; padding `nav-h + safe-area` |
| Collision | Si l'utilisateur drague un compagnon vers la gauche : Inventoria FAB peut `translateY(-8px)` court **ou** réduire opacity 0.85 — jamais inverser les docks de façon permanente sans prefs |

---

## 3. Coexistence Transferania / Else

| Situation | Comportement |
|-----------|--------------|
| Idle tous | FAB visible admin ; chips sœurs inchangées |
| Inventoria ouvert | Sheet/panneau depuis la **gauche** ou bottom-sheet full width ; chips droites restent visibles au moins en pill / avatar |
| Companion chat ouvert | Inventoria ne force pas la fermeture ; si manque d'espace (&lt;360 px largeur utile), Inventoria passe en **overlay modal** avec bouton fermer explicite |
| Assistant AI (`#btn-ai`) | Priorité z-index AI ; Inventoria reste sous AI |
| Intime view | FAB Inventoria **masqué** (espace compagnon sacré) — réactivation hors `intime` |
| Pointer events | Conteneurs `pointer-events: none` sur wrappers ; seuls bouton + panneau `auto` |

Mémoires / threads : stores séparés — l'UI n'offre pas de « fusion de chat ».

---

## 4. Ouverture simultanée, focus, clavier, petit écran

### Ouverture simultanée

| Combo | Résultat |
|-------|----------|
| Inventoria + Transferania bubble | Autorisé ; une seule zone clavier à la fois |
| Inventoria + Else chip expand | Autorisé ; focus compose Inventoria si l'utilisateur vient d'ouvrir Inventoria |
| Inventoria + AI assistant | AI gagne le focus si ouvert après ; Inventoria reste en arrière-plan sheet |
| Deux panels Inventoria | Interdit — une session UI |

### Focus

1. Ouverture FAB → focus sur champ compose Inventoria (`autofocus` desktop ;
   mobile : focus après geste utilisateur pour éviter clavier sauté).
2. Fermeture → focus renvoyé au FAB (roving) ou à la vue active.
3. `Esc` / bouton fermer → ferme Inventoria sans tuer les compagnons.

### Clavier virtuel (iOS / Android)

- Bottom-sheet : `height: min(85dvh, …)` ; zone compose **au-dessus** du clavier
  (`visualViewport` resize / `env(keyboard-inset)` si dispo).
- Ne pas utiliser `position: fixed` compose coincé sous le clavier.
- PreviewDiff sticky **au-dessus** du compose, scrollable séparément.

### Petit écran (&lt;400 px largeur, hauteur &lt;700 px)

- Mode **sheet full-bleed** (pas de panneau flottant 360 px).
- Preview des changements : onglet / segment `Chat | Aperçu` (une surface à la fois).
- FAB : ne pas empiler tooltip long ; toast court après commit.
- Safe-area notches respectés ; pas de gesture edge-swipe qui vole le back-nav
  système sans confirmation si preview dirty.

### Preview dirty

Si l'utilisateur confirme un preview puis tape ailleurs : demander
« Abandonner les changements proposés ? » avant close — ne pas commit silencieux.

---

## 5. États UI (rappel)

`idle → chatting → proposals → preview → committing → done | error | reconcile`

- `committing` : FAB + panneau non dismissables accidentellement (spinner + Annuler
  désactivé ou confirmé).
- `reconcile` : CTA clair vers écran de reprise (pas de retry adjust auto).

---

## 6. Hors scope PR #30

- Aucun markup FAB dans `iphone_bridge.py` / CSS live.
- Aucun `data-nav="finances"|"repas"`.
- Aucun lazy script Inventoria enregistré.

Implémentation UI : PR #37 selon [11-incremental-pr-plan.md](11-incremental-pr-plan.md).
