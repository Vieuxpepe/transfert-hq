# Consigne agent : plusieurs coffres, phases V1 à V3

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
Static. This relationship canon does not fabricate shared conversations,
merge memories or authorize messages between the sisters.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Lire d'abord `docs/forge-multi-vault-plan.md` en entier, puis `docs/forge-studio-next-features-plan.md` section 0 (règles qui ne bougent pas).

## Décision du propriétaire (définitive)
Nom, glyphe et couleur sont **lisibles quand le coffre est verrouillé** (stockés en clair dans le registre). Chaque coffre a une option **Discret** : son nom n'est alors stocké que chiffré, et verrouillé on ne voit que glyphe, couleur et numéro. Aucune image réelle en clair.

## Périmètre de cette consigne
Seulement V1 (stockage et migration), V2 (sessions et tentatives) et V3 (routes). Pas d'interface (V4), pas d'icône ni de tri (V5), pas de sauvegarde, restauration ni suppression par coffre (V6). Ne rien construire de V4 à V6, même si c'est tentant.

## Départ
- Partir de la branche `feat/forge-ghi` (tip après correction d'auteur). Créer `feat/forge-multivault`.
- Ne jamais toucher au vrai dossier du coffre pendant le développement ni les tests (`set_root_for_tests` et dossiers temporaires uniquement).
- Ne rien pousser ni déployer.

## V1 : stockage et migration
1. Registre `forge-vault/registry.json` (clair, version 1) : `{id, label|null, glyph, colour, discret, order, created, last_used_day}` par coffre. Validation stricte à la lecture (longueurs, glyphes et couleurs dans des jeux fixes). Un registre altéré ne doit jamais donner accès ni mélanger des coffres.
2. Dossiers `forge-vault/vaults/<vid>/` avec exactement la structure actuelle. `vid = "vlt-" + 16 hex aléatoires`, jamais dérivé du nom.
3. Un coffre « Discret » : étiquette absente du registre, stockée chiffrée dans le coffre.
4. Toutes les fonctions du module prennent un `vid` : racine, en-tête, index, objets, quotas par coffre (2 Gio, 400 images), plus plafond global et nombre maximal de coffres (12).
5. Migration du coffre existant : renommage atomique de l'ancien dossier vers `vaults/<vid>/`, étiquette « Coffre », sans rechiffrer ni recopier. Le registre n'est écrit qu'après le renommage. Un état à moitié migré doit se terminer ou s'annuler sans perte au démarrage suivant. Réappliquer scellement ACL et contrôles réparse au nouvel emplacement.
6. La migration se déclenche seulement à la première ouverture explicite du panneau coffre, jamais en silence au démarrage, après qu'une sauvegarde ZIP a été proposée.

## V2 : sessions et tentatives
1. Sessions par `(jeton, vid)`, TTL et verrou automatique par coffre. Verrouiller en quittant l'app, déconnexion et `lock_all` ferment tous les coffres.
2. Un seul coffre ouvert à la fois par session : en ouvrir un verrouille l'autre.
3. Limite de tentatives par `(jeton, vid)` **et** limite globale tous coffres confondus.
4. Le panneau privé exige le coffre de destination, déjà ouvert. Jamais « le dernier utilisé » en silence. La retouche privée écrit dans le coffre de l'image source.

## V3 : routes
1. Chemins `/api/forge/vaults/<vid>/…`, comme les identifiants d'image. Aucun nom dans les URLs ni les logs.
2. Nouvelles routes : liste (lecture seule, ne montre que ce que le registre autorise), créer, modifier (nom, glyphe, couleur, discret, ordre). Pas de route de suppression ici.
3. Toutes admin + CSRF, tests 401/403/404. Aucune route non authentifiée. Les listes autorisées Forge ne changent pas.
4. Les anciennes routes `/api/forge/vault/*` restent comme alias du coffre migré jusqu'à V4.

## Tests obligatoires (en plus de la suite existante)
- Un coffre n'ouvre jamais un autre : mauvaise phrase, mauvais `vid`, identifiant d'image d'un autre coffre, traversée de chemin.
- Registre falsifié ou corrompu : aucun accès, aucune fuite, erreur claire.
- Limite globale : N coffres n'augmentent pas la vitesse d'essai.
- Verrouillage automatique, `lock_all`, déconnexion : tout se ferme et les index disparaissent de la mémoire.
- Aucun tag, prompt ni nom « Discret » en clair sur disque, dans aucun dossier de coffre ; le registre ne contient que les champs permis.
- Aucune étiquette dans les logs, l'historique, le stockage navigateur ni les workers.
- Migration : réussie, rejouée sans effet, coupée en plein milieu, annulée ; images et index identiques avant et après.
- Quotas par coffre et global, nombre maximal de coffres.

## Méthode et rapport
- Petits commits, un par étape numérotée. Messages sans attribution personnelle : vérifier l'auteur avec `git log --format='%an %ae'` avant de rendre la main.
- Suites Python complètes : lancer sur le commit de départ **et** sur le tip, et comparer. Toute différence doit être expliquée.
- Suites navigateur Forge en Chromium et WebKit, en distinguant les échecs connus.
- Vérifier qu'aucun fichier n'a été corrompu par l'encodage (chercher `Ã©`, `Ã¨`, `â€` dans le diff).
- Arrêt et question si une étape exige d'assouplir une règle de sécurité.
- Rapport final : ce qui marche, ce qui n'est prouvé qu'avec des mocks, ce qui reste non vérifié (surtout la migration sur de vraies données), patch et SHA-256.
