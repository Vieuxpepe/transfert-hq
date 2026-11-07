# Forge Studio : plan d'implémentation des prochaines fonctions

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Destiné à un agent qui travaille plusieurs heures. Lire en entier avant de commencer.

## 0. Règles qui ne bougent pas

Ces règles passent avant toute fonction. En cas de doute, ne pas livrer la fonction et le dire.

1. Bridge en Python stdlib uniquement. Aucune dépendance ni framework nouveau. JS/CSS simples.
2. Ne jamais affaiblir CSP, CSRF, rôles admin ni nosniff. Pas de CDN, pas de handler inline, pas de route non authentifiée.
3. Aucun secret dans les URLs, les logs, l'UI ni argv.
4. Prompts et images privés restent locaux et isolés : jamais dans l'historique, les jobs, la galerie, les logs, le stockage navigateur, les workers distants ni le cloud. Les statistiques et analyses EXCLUENT le coffre par défaut.
5. HQ n'interrompt, ne saute et ne reconfigure jamais le Forge du propriétaire : pas de `/sdapi/v1/options` en écriture, pas d'interrupt/skip, aucun changement de modèle hors du corps de requête du job.
6. Un seul propriétaire, usage personnel : pas de comptes, de social ni de cloud.
7. UI en français, calme : pas de gamification, confettis, sons ni notifications bruyantes. Cible 375 px, tactile, rien qui dépende du survol.
8. Toute nouvelle route : admin + CSRF, tests 401/403/404. Toute modification des listes autorisées Forge : test que la liste = ancienne liste + exactement la route ajoutée.

## 1. Point de départ

- Branche de base : `feat/forge-distinct` (5 commits sur `4d7bb05` : parité de flotte, partage du GPU, variations, comparaison des LoRA, correction du double rafraîchissement). Vérifier qu'elle est fusionnée ou partir d'elle. Ne rien pousser ni déployer sans accord.
- Fichiers principaux : `hq_forge.py`, `hq_forge_jobs.py`, `hq_forge_fleet.py`, `hq_forge_gallery.py`, `hq_forge_vault.py`, `hq_forge_presets.py`, `hq_forge_worker.py`, `assets/hq-forge.js`, `assets/hq-forge.css`, `docs/forge-workers.md`.
- Tests : `tests/test_hq_forge_*.py` et les suites visuelles `tests/visual_forge_*_playwright.*`. Ils utilisent des mocks (`tests/forge_fleet_mocks.py`).
- Échecs connus à ne pas confondre avec les vôtres : deux tests WebKit (studio, presets) ; un test de permissions de nouvelle tentative flaky (~1 sur 5).

## 2. Méthode de travail

- Une fonction = une branche courte ou un commit isolé et un message clair. Ne jamais mélanger deux fonctions dans un commit.
- Avant chaque fonction : lire le code concerné, écrire les tests d'abord pour les règles de sécurité.
- Après chaque fonction : suite Python complète, suites navigateur concernées en Chromium ET WebKit. Si WebKit s'arrête sur un échec connu avant d'arriver aux nouveaux tests, exécuter les nouveaux tests seuls en WebKit.
- Mesurer, ne pas supposer : pour tout champ de l'API Forge marqué [vérifier], faire une lecture seule sur le Forge réel (inactif) avant d'écrire du code qui en dépend. Documenter le résultat dans `docs/forge-workers.md`.
- S'arrêter et signaler si une fonction exige d'assouplir une règle de la section 0.
- À la fin de chaque phase : un court rapport (ce qui marche, ce qui est prouvé seulement avec des mocks, ce qui reste non vérifié), plus un patch avec son SHA-256.

## 3. Ordre des phases

Les phases se suivent. Chaque phase peut être livrée seule.

### Phase A : Fondations de données (S)
But : enregistrer ce qui manque pour tout ce qui suit.
- Inventaire : lister ce que l'historique des jobs stocke déjà par job et par image (checkpoint, sampler, scheduler, CFG, pas, taille, lot, seed, PC exécutant, durée, issue, tentative, état incertain). Écrire l'inventaire dans le rapport.
- Ajouter les champs manquants, sans prompt. Les statistiques n'ont besoin que de réglages, durées et issues.
- Ajouter un indicateur de tri par image : `garde | rejeté | favori | non trié`, réversible. Rejeté = masqué dans une corbeille, pas supprimé définitivement.
- Migration douce : les anciens jobs sans champ restent lisibles.
- Tests : migration, champs absents, aucune donnée de coffre écrite dans l'historique.

### Phase B : Tri rapide + Laboratoire (M)
Dépend de A.
- Écran plein écran : toucher ou balayer pour garder, rejeter, favori ; annuler le dernier geste. Corbeille réversible. Fonctionne aussi dans le coffre, avec l'état gardé dans le coffre chiffré (jamais dans l'historique).
- Laboratoire (analyseur) en trois vues séparées, sans note globale unique :
  - Vitesse : durée par image selon config et PC.
  - Fiabilité : échecs de mémoire, images manquantes, nouvelles tentatives par config.
  - Taux de garde : part d'images gardées par réglage, avec effectif visible.
- Règles d'honnêteté : minimum environ 20 images par réglage sinon « pas assez de données » ; comparer seulement à checkpoint et résolution comparables ; libellé « ce que tu gardes », pas « qualité » ; afficher les combinaisons confondues, pas de cause inventée.
- Bouton « Appliquer ces réglages » qui remplit le formulaire, sans rien changer en silence.
- Une seule route en lecture, admin, avec test. Barres simples, pas de graphiques.
- Livrer d'abord vitesse + fiabilité, puis taux de garde.

### Phase C : Planificateur honnête (M)
Dépend de A et des statistiques de vitesse.
- Avant de lancer : fourchette de durée par PC et répartition conseillée, à partir des mesures réelles. « Pas assez de données » sous le seuil.
- Avertir sur les combinaisons taille × lot qui ont déjà échoué (mémoire). `GET /sdapi/v1/memory` est un signal faible : [vérifier] qu'il existe sur ce Forge, ne pas en dépendre.
- Prolonge l'estimation de durée existante, ne la remplace pas.

### Phase D : Journal de bord (S-M)
- Par job : chronologie lisible (quel PC, quoi, quand).
- Les tâches incertaines (jamais relancées automatiquement) deviennent un choix explicite : relancer, marquer perdue, garder tel quel. Aucune relance automatique, jamais.
- Pur affichage au-dessus des données existantes, replié par défaut.

### Phase E : Exploration (M)
Dépend de la fonction Variations déjà livrée.
- Balayage d'un paramètre : choisir un axe (CFG, pas, sampler, poids d'un LoRA) et quelques valeurs, plafonné à environ 8 cellules ; réparti sur la flotte (la parité de flotte garantit le même modèle) ; affiché en bande qu'on balaie au doigt.
- Brouillons puis finition : de nombreux brouillons sur la flotte, tri, puis finition des gardées sur le GPU principal (hires ou upscale). Étiqueter « finition », pas « identique » : changer de résolution change la composition.
- Comparateur A/B : deux images, pincement synchronisé, curseur de révélation, différence de paramètres. Côté client uniquement, attention à la mémoire sous iOS Safari.

### Phase F : Flotte (S puis M)
- Réveil à distance (S) : bouton qui envoie un paquet Wake-on-LAN depuis le coordinateur (socket UDP stdlib). Action authentifiée + CSRF. Fonctionne seulement sur le même réseau local que la cible, pas à travers Tailscale : le dire dans l'UI et la doc. Réveil uniquement, jamais d'extinction ni de mise en veille à distance.
- Messages d'exclusion plus précis pour les LoRA : distinguer « LoRA absent », « liste illisible », « liste trop grande (> 1 Mo) » et « au-delà de la limite de 96 ».

### Phase G : Atelier de nuit (M)
Dépend de B et du partage du GPU.
- File de jobs en mode normal uniquement : « Lancer ce soir » ou « quand Forge est libre », en utilisant la détection d'occupation existante.
- Un résumé calme à l'ouverture le matin : pas de notification, pas de son.
- Les jobs privés ne sont JAMAIS mis en file. Dire pourquoi dans l'UI.
- Garde-fous : limite de durée, annulation simple, jamais d'interruption du Forge du propriétaire.

### Phase H : Coffre cherchable (M)
- Index chiffré dans le coffre : tags, collections, recherche dans les prompts privés.
- L'index n'existe qu'en mémoire pendant le déverrouillage et disparaît au verrouillage automatique. Rien dans le stockage navigateur ni dans les logs.
- Tests : verrouillage vide l'index, aucune fuite hors du coffre, comportement en cas d'erreur.

### Phase I : Retouche au doigt, y compris privée (L)
À faire en dernier, séparément.
- Masque tracé au doigt, régénération de la zone (img2img avec masque). Précision sur 375 px et limites du canvas iOS : prototyper tôt.
- En mode coffre : source et résultat restent dans le coffre ; le masque et l'image sont traités en mémoire, aucun fichier temporaire.
- Envoi seulement au Forge local de ce PC, jamais à un worker distant pour le privé.

### Phase J : Idées à valider avant de les construire
Ne pas commencer sans accord : briques de prompt avec mots-clés LoRA, arbre de généalogie d'une image, style maison issu des images gardées, mode « canapé ».

## 4. Vérifications finales par phase

- Suite Python complète verte.
- Suites navigateur Chromium et WebKit, en distinguant clairement les échecs connus.
- Un essai sur matériel réel quand c'est possible (un vrai LoRA, un second PC) ; sinon le dire explicitement dans le rapport.
- Captures d'écran à 375 px, regardées par un humain avant le déploiement.
- Revue de sécurité de chaque nouvelle route et de chaque donnée stockée (rien du coffre ne doit atteindre l'historique ni les statistiques).

## 5. Ce qui est volontairement exclu

Temps réel façon Krea, notifications push, expansion de prompt par LLM, téléchargement de modèles Civitai, éditeur de nœuds, interrogation d'image par CLIP, extinction ou veille à distance des workers, tableaux de bord de température GPU, coffre leurre, partage social, étiquetage ML.
