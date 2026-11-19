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

---

## 7. Saisie rapide (2026-11)

- **Auto-application** (Réglages → Saisie rapide, activée par défaut) : un changement de quantité simple sur un article existant
  s'applique aussitôt et affiche un toast « Noté : … · Annuler » pendant 10 s. Créer, déplacer, modifier ou tout cas douteux reste
  un brouillon ; les seuls articles nouveaux (lignes inconnues d'un ticket) deviennent une question courte « Nouveaux articles — les ajouter ? ».
- **Raccourci iPhone** : Raccourcis → « Dicter le texte » → « URL » `https://<hôte HQ>/#inventoria-say=` + texte dicté → « Ouvrir les URL ».
  Nommé « Inventoria » pour Siri, ou sur le bouton Action. Utilise la session Safari déjà connectée (aucun nouvel accès au pont).
- **Étiquettes QR** : Réglages → « Imprimer les étiquettes QR des emplacements ». Chaque QR ouvre `#inventoria-place=<code>` :
  contenu, « Compter par photo », « Ajouter ici ».
- **Codes-barres** : bouton scanner dans la barre de discussion (`assets/vendor-zxing.min.js`, @zxing/library 0.21.3, Apache-2.0,
  chargé à la demande). En http simple (pas de flux caméra), une photo du code-barres est décodée à la place. Un code inconnu se lie
  une fois à un article existant ; ensuite chaque scan propose −/+ (quantité habituelle).
- **Notifications** : une alerte pour un seul article porte « Ajouter à la liste » / « Ignorer » (ordinateurs, Android) ; sur iPhone
  (pas de boutons), le toucher ouvre la même question dans HQ.
- **Elle apprend** : surnoms (« PQ » = papier toilette, liste dans Réglages), quantité habituelle par article, emplacement et unité
  habituels d'un nom d'article (`.hq-inventoria/habits.json`).

## 8. Ce que permet un stock fiable (2026-11)

- **Où est… ?** « Où sont les vis M3 ? » répond tout de suite (sans modèle) : chemin de l'emplacement, quantité, photo de l'article
  ou, à défaut, de l'emplacement. Sans correspondance, la question part à Inventoria.
- **Ne jamais manquer** : le résumé du matin regroupe la liste par magasin et ouvre l'onglet « À acheter » (`#inventoria-shop`) ;
  la liste à cocher est groupée par magasin, et cocher puis valider met le stock à jour aussitôt (avec Annuler).
- **Repas** : « Je peux faire le riz au lait ce soir ? » vérifie la recette enregistrée (Repas) contre le stock ; « J'ai cuisiné… »
  retire les ingrédients (conversion g/kg, ml/L ; ce qui ne se compte pas en unités entières est signalé, pas deviné).
- **Prix** : à la lecture d'un ticket, elle note le prix de chaque ligne reconnue (magasin, date) : historique, « le moins cher chez »,
  dépenses du mois par catégorie (1re étiquette de l'article) et par magasin. Journal propre à Inventoria : le registre Finances
  n'est pas modifié.
- **Atelier 3D** : relier une matière (PLA, PETG…) à un article de filament compté en g ou kg ; chaque impression terminée ensuite
  retire ses grammes, une seule fois. « Je peux construire X ? » compare une liste de pièces au stock.
- **À utiliser bientôt** : une date de péremption donnée par le Maître (jamais devinée) ; l'onglet « À acheter » liste ce qui expire
  sous 5 jours (et les lots alimentaires du module Courses s'il y en a) avec « Idées de repas avec ça ».
- **Vérification de la semaine** : l'onglet propose l'emplacement compté il y a le plus longtemps ; un compte par photo enregistre
  l'écart et affiche la fiabilité du stock (part des articles justes sur 90 jours).


## 9. Passe d'interface (2026-11)

- **Page Inventaire** : recherche courte (« Chercher un objet, un lieu… ») avec bouton scanner (affiché dès que la puce Inventoria est
  prête, événement `hq:inventoria-ready`) ; filtres sur une seule rangée défilante ; une recherche commence par une ligne « où c'est »
  (objet — chemin — quantité) ; l'état vide propose « Dis-lui ce que tu as » et « Photo d'une étagère » en plus de créer un
  emplacement ; marge basse de 150 px pour que le contenu défile au-dessus de la puce.
- **Panneau Inventoria** : une seule carte à la fois (brouillon, revue photo, courses, scanner, info) — la plus récente est devant,
  une barre « Aussi en attente : … » ramène l'autre, rien n'est perdu ; un seul bouton appareil photo (menu Photo / Scanner) ;
  bouton Envoyer réduit à son icône sur téléphone ; puce « Où est… » ; le toast d'annulation attend tant qu'on le touche ;
  Réglages en accordéon (Saisie rapide ouverte, Raccourci/QR, Surveillances, Alertes, Photos, Notes) ; À acheter : la liste d'abord,
  puis une bande repliée (à utiliser, vérification de la semaine, fiabilité) qui s'ouvre seule si quelque chose est périmé ;
  cibles tactiles de 44 px (les anciennes règles « téléphone » à 36–40 px ont été relevées).
- Vérifié dans Chromium (téléphone 390 px, serveur jetable) : tailles réelles 44 px, saisie à 195 px de large, accordéon, menu appareil.
  Pas vérifié en réel : le toast d'annulation, les cartes empilées, le scan caméra.

## 10. Lisibilité, visuels, animations (2026-11)

- **Texte** : rien sous 12 px sauf la pastille de compteur ; boutons désactivés à 62 % d'opacité (50 % rendait « Marquer acheté »
  illisible) ; cases à cocher des réglages alignées sur la première ligne ; les puces de revue photo passent à 12 px. Contraste
  mesuré sur pixels réels (clair/sombre × 390/320 px, autres modules masqués) : aucun texte sous 4,5:1 ; les rares alertes à ≈1:1 étaient
  du texte dans des sections repliées ou défilées hors champ.
- **Visuels** : « Où est… ? » est une simple réponse dans le fil (plus de carte qui répète) ; la carte n'apparaît que s'il y a une photo
  (légende = chemin) ou d'autres résultats, et n'est plus rognée par l'ancien plafond de 240 px ; la bande « à utiliser / vérification /
  fiabilité » ne cumule plus une icône par rafraîchissement (bug : 6 yeux) ; le fil se recale sur le dernier message.
- **Animations** (transform/opacité seulement, ≤ 0,34 s) : carte/toast qui montent, pastille ✓ qui « pop », menu appareil photo, barre
  « en attente » et onglets qui fondent, nouveaux messages qui montent (jamais à la restauration du fil), ligne « où c'est » de la page.
  Désactivées par `prefers-reduced-motion: reduce` et par le mode économe de HQ (`.is-motion-lite`). Vérifié : sans préférence les 5
  animations tournent, avec « réduire » elles valent toutes `none`.

## 11. Suivi, fiche article, hors ligne, langue (2026-11)

- **Onglet Suivi** (`hq-inventoria-suivi.js`, branché sur `window.HqInventoria.ui`) : *Historique* (lots appliqués, jour par jour, « auto »,
  Annuler en un geste), *Pouvoir faire* (recette enregistrée → vérifier le stock → « J'ai cuisiné » ; liste de pièces → « Puis-je le
  construire ? » ; ce qui manque part aux courses), *Dépenses* (mois, par catégorie et par magasin), *Filament 3D* (matière ↔ article,
  impressions retirées), *Codes-barres* (liste, délier, lier à la main).
- **Fiche article** (touche un nom dans À acheter / À utiliser / alertes, « Fiche » après un scan ou un « où est… ») : quantité −1/+1, seuil
  minimum, date de péremption, codes-barres, surnoms, quantités habituelles, historique des prix et le moins cher, lien filament pour un
  article compté en g. Échap la ferme, même après une sauvegarde.
- **Hors ligne** : un changement fait sans réseau (−/+ d'un scan, cases cochées, une phrase) est gardé, un bandeau dit ce qui attend, et il
  part une seule fois au retour du réseau — chaque envoi porte un `client_id` que le serveur reconnaît s'il l'avait déjà appliqué.
  Les photos demandent une connexion.
- **Langue** : le texte propre du panneau suit le même réglage que ses réponses (`hq-inventoria-i18n.js` : dictionnaire + motifs pour les
  libellés du serveur ; les messages du fil ne sont jamais réécrits ; la langue est mémorisée pour ne pas clignoter).
- **Retour** : une courte vibration quand un changement est appliqué (Android : `vibrate`, iPhone 17.4+ : interrupteur natif), le son
  « done » de l'assistant, et un réglage pour couper la vibration.

## 12. Plaisir d'usage (2026-11) — `hq_inventoria_feel.py`

- **État calme** : quand il y a du stock et rien à acheter ni à utiliser bientôt, l'onglet À acheter le dit (« Nothing to buy, nothing
  expiring, last count 3 days ago. ») au lieu de rester muet ; jamais sur un inventaire vide. Une ligne discrète « Rien n'a manqué depuis
  N jours » apparaît après 7 jours *de suivi réel* (le compteur démarre à la première observation, jamais avant) et repart à zéro dès
  qu'un article tombe à « out ».
- **Marques d'apprentissage, seulement si c'est vrai** : « Quantité habituelle » sur le toast quand aucun nombre n'a été dit **et** que le
  montant égale l'habituel appris (`feel.mark_usual`, sans nombre en chiffres ni en mots) ; « Vérifié ✓ · il y a N j » sur la fiche d'un
  article compté (`links.item_checked_days`).
- **Une supposition se corrige sur place** : si la confiance d'un seul ajustement n'est pas « high », la carte montre « J'ai compris
  « X » — pas celui-là ? » avec les trois articles les plus proches ; un tap annule ce brouillon et applique le même changement à l'autre
  article (toast + Undo). Jamais proposé pour une correspondance sûre ni pour un lot de plusieurs changements.
- **Mode courses** (onglet À acheter) : lignes de 56 px, toute la ligne coche, groupé par magasin, les coches survivent à une appli
  fermée, bouton « Marquer acheté » collant en bas, écran gardé allumé si le navigateur le permet ; il se ferme tout seul quand la liste
  est vide. Pas de rayon : les articles n'ont pas de catégorie ni d'ordre de magasin, donc le regroupement s'arrête au magasin.
- **Sa voix** : le serveur fournit `status.tone` (toast, ligne « c'est fait », annulation, hors ligne, tête du résumé du matin) dans la
  langue du réglage ; le choix de la phrase est stable (même opération, même phrase).
- **Budget de sollicitation** (`feel.json`, réglage « Discrétion ») : silence de 22 h à 7 h, 4 alertes instantanées par jour, pause 1 jour /
  1 semaine. Une alerte retenue n'est pas perdue : elle reste « fraîche » et part après. Le résumé du matin n'est jamais plafonné mais
  respecte pause et silence ; « Pas aujourd'hui » repousse seulement la vérification hebdomadaire.
- **Jamais bloquant** : un tap −/+ affiche « Saving… » en quelques millisecondes (mesuré : 5–13 ms sur un réseau émulé à 1,5 s) puis la vraie
  réponse ; hors ligne il part en file (voir §11) et, si la première tentative échoue juste au retour du réseau, une relance a lieu 3 s plus tard
  (4 fois au plus) au lieu d'attendre 30 s.
