# Forge Studio : plusieurs coffres (nom, mot de passe, icône, tri)

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


Plan pour un agent. S'ajoute à `docs/forge-studio-next-features-plan.md`. Mêmes règles : stdlib seulement, CSP/CSRF/rôles intacts, aucun secret dans URLs/logs/UI/argv, UI française et calme, 375 px d'abord.

## 0. Ce que demande le propriétaire

- Créer plusieurs coffres, chacun avec son nom, son mot de passe (et sa clé de récupération), son icône ou miniature, et un tri pour s'y retrouver.

## 1. Situation actuelle (lue dans `hq_forge_vault.py` à `feat/forge-ghi`)

- Un seul coffre : dossier `%LOCALAPPDATA%\TransfertHQ\forge-vault` avec `vault.json` (clé maîtresse enveloppée par une phrase via Argon2id + AES-256-GCM, plus une clé de récupération), `objects/` (une clé de données par image) et un index chiffré (tags, collections, tri).
- Déverrouillage en mémoire, **une entrée par jeton de session HQ** (`_sessions[token]`), verrou automatique, quotas (2 Gio, 400 images), blocage des tentatives par jeton, scellement ACL Windows, sauvegarde ZIP, refus des liens réparse.
- Les routes `/api/forge/vault/*` n'ont aucune notion de « quel coffre ».

Conséquence : ce n'est pas un simple champ « nom » à ajouter. Il faut un coffre = un dossier = ses propres clés, et rendre toutes les fonctions (sessions, quotas, tentatives, sauvegarde, recherche, retouche privée) conscientes du coffre.

## 2. Décision de confidentialité (à trancher, défaut recommandé)

Un nom et une icône **visibles pendant que le coffre est verrouillé** doivent être stockés en clair sur le disque. C'est le prix de « mieux voir et trier ».

- **Défaut recommandé :** étiquette courte + glyphe + couleur en clair dans un registre. Aucune image réelle en clair. Un avertissement à la création : « Ne mets rien de sensible dans le nom ».
- **Miniature photo :** une image du coffre peut devenir l'icône, mais elle est stockée **chiffrée dans ce coffre** et ne s'affiche que quand il est ouvert. Verrouillé, on voit le glyphe et la couleur.
- **Option par coffre « Discret » :** le nom n'est alors stocké que chiffré. Verrouillé, la liste montre seulement le glyphe, la couleur et un numéro.
- Jamais de recherche entre coffres : elle exigerait plusieurs clés ouvertes à la fois.

## 3. Conception

**Disque**
- `forge-vault/registry.json` (clair, version 1) : liste de `{id, label|null, glyph, colour, discret, order, created, last_used_day}`.
- `forge-vault/vaults/<vid>/` : exactement la structure actuelle (`vault.json`, `objects/`, index). `vid = "vlt-" + 16 hex aléatoires`, jamais dérivé du nom.
- Le registre n'a aucun poids cryptographique : l'altérer ne doit jamais donner accès ni mélanger des coffres. Valider chaque champ à la lecture (longueurs, jeux de glyphes et de couleurs fixes).

**Sessions et tentatives**
- Sessions clés par `(jeton, vid)`, TTL et verrou automatique par coffre. Verrouiller en quittant l'app, déconnexion et `lock_all` ferment **tous** les coffres.
- Par défaut un seul coffre ouvert à la fois par session (ouvrir B verrouille A). C'est plus sûr et plus simple à expliquer.
- Limite de tentatives par `(jeton, vid)` **et** limite globale tous coffres confondus, pour qu'une session ne puisse pas essayer N coffres à N fois la vitesse.

**Génération privée, retouche, tri, recherche**
- Le panneau privé exige de choisir explicitement le coffre de destination, déjà ouvert. Jamais « le dernier utilisé » en silence.
- La retouche privée écrit dans le coffre de l'image source.
- Laboratoire et atelier de nuit continuent d'exclure tous les coffres.
- Quotas par coffre (2 Gio, 400 images) plus un plafond global et un nombre maximal de coffres (proposition : 12).

**Routes**
- Mettre l'identifiant du coffre dans le chemin (`/api/forge/vaults/<vid>/…`), comme les identifiants d'image. Pas de nom dans les URLs ni les logs.
- Nouvelles : liste (lecture seule, ne montre que ce que le registre autorise), créer, modifier (nom, glyphe, couleur, discret, ordre), supprimer. Toutes admin + CSRF, tests 401/403/404.
- Garder les anciennes routes comme alias du coffre migré jusqu'à ce que l'UI soit passée, puis les retirer.

**Migration du coffre existant** (point le plus risqué : vraies données)
- Déplacement atomique (renommage), **pas de recopie ni de rechiffrement** : l'ancien dossier devient `vaults/<vid>/`, étiquette « Coffre », glyphe par défaut.
- Reprise sûre après coupure : le registre n'est écrit qu'après le renommage, et un démarrage qui trouve un état à moitié migré le termine ou l'annule sans perte.
- Réappliquer le scellement ACL et les contrôles réparse sur le nouvel emplacement.
- Faite à la première ouverture du panneau coffre, après une sauvegarde ZIP du propriétaire proposée, jamais en silence au démarrage.
- Les tests n'utilisent **jamais** le vrai dossier (`set_root_for_tests`). Essai à blanc sur une copie avant tout déploiement.

**Interface (375 px)**
- Écran « Mes coffres » : cartes en 2 colonnes (tuile glyphe sur couleur, nom, état verrouillé/ouvert). Toucher une carte ouvre la feuille de mot de passe de ce coffre.
- Création : nom, grille de glyphes, nuancier de couleurs avec contraste vérifié, phrase + confirmation, clé de récupération affichée une seule fois.
- Tri : manuel avec boutons monter/descendre (pas de glisser-déposer), plus par nom et par récent (jour seulement). Le récent est visible en clair : le dire.
- Boutons d'au moins 44 px, aucune action au survol, textes courts.

**Suppression, sauvegarde, récupération**
- Sauvegarde ZIP et restauration par coffre. Restaurer crée un nouveau coffre (pas d'écrasement), avec un nouvel identifiant.
- Suppression d'un coffre : sa phrase + confirmation tapée, avertissement irréversible, suggestion de sauvegarde avant.
- Changer la phrase et la clé de récupération : par coffre.

## 4. Phases

1. **V1 : stockage et migration** (M-L). Registre, dossiers par coffre, migration sûre, tests d'isolation et de reprise sur coupure.
2. **V2 : sessions et tentatives** (M). Clés `(jeton, vid)`, limite globale, un seul coffre ouvert, verrouillage de tous.
3. **V3 : routes** (M). Chemins par coffre, alias temporaires, tests d'autorisation.
4. **V4 : interface** (M). Liste, création, déverrouillage, choix du coffre pour la génération privée.
5. **V5 : icône et tri** (S-M). Glyphe, couleur, miniature photo chiffrée, ordre.
6. **V6 : sauvegarde, restauration, suppression** (M).
Livrer V1 à V3 d'abord (rien de visible mais tout repose dessus), puis V4 à V6.

## 5. Tests exigés

- Un coffre ne peut jamais ouvrir un autre (mauvaise phrase, mauvais identifiant, identifiant d'image d'un autre coffre, traversée de chemin).
- Registre falsifié ou corrompu : aucun accès, aucune fuite, erreur claire.
- Limite globale de tentatives : N coffres n'augmentent pas la vitesse d'essai.
- Verrouillage automatique, `lock_all`, déconnexion : tous les coffres se ferment et l'index disparaît de la mémoire.
- Aucun tag, prompt ni nom « discret » en clair sur disque dans aucun dossier de coffre ; le registre ne contient que les champs permis.
- Aucune étiquette ni miniature dans les logs, l'historique, le stockage navigateur ou les workers.
- Migration : réussie, rejouée sans effet, coupée en plein milieu, annulée ; les images et l'index sont identiques avant et après.
- Quotas par coffre et global ; sauvegarde puis restauration crée un nouveau coffre ; suppression bien irréversible.
- Navigateur (Chromium et WebKit) : liste, création, déverrouillage, changement de coffre, verrouillage à l'arrière-plan.

## 6. Risques et points de vigilance

- Module cryptographique central (1700+ lignes) : petits commits, relecture humaine du diff des clés et des sessions.
- Les vraies données de l'utilisateur : sauvegarde obligatoire avant migration, essai sur copie, jamais de test sur le vrai dossier.
- Fuite de métadonnées : noms, glyphes et dates visibles verrouillé. À expliquer dans l'UI, avec l'option Discret.
- Complexité d'interface : beaucoup d'écrans sur 375 px. Garder un parcours simple (liste, ouvrir, créer).
