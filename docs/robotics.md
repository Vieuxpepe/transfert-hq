# Robotique dans Transfert HQ

Ouvrir **Robotique** dans la barre latérale, ou **Plus → Autres espaces → Robotique** sur mobile. L’espace est réservé aux sessions administrateur. **Système → Réglages Robotique** ouvre la configuration. Le profil livré est le RoArm-M2-S avec pince d’origine, en mode firmware `EEMode=0`.

## Simulation

1. Ouvrir Robotique. L’état initial affiche **Simulation**, **Bras virtuel** et **Désarmé**.
2. Saisir quatre angles ou une cible XYZ et cliquer **Aperçu**. L’onglet **Position** affiche le plan XY, la position courante et la cible prévisualisée. X, Y et Z sont exprimés en millimètres dans le repère firmware, avec l’origine Z à l’axe d’épaule. La quatrième coordonnée est l’angle de pince en degrés.
3. Cliquer **Armer**, puis **Déplacer**, ou activer brièvement un bouton +/−. Un appui suivi d’un relâchement valide produit un pas. Un relâchement hors du bouton, une annulation tactile ou une perte de focus avant validation abandonne le pas. Le maintien ne répète pas le mouvement.
4. Les colonnes **Simulé** et **Demandé** suivent la progression. **Déplacer au neutre** est un mouvement volontaire vers 0°, 0°, 90°, 180°.
5. Dans **Positions**, enregistrer une cible, la charger pour l’examiner et l’exécuter après armement. Dans **Séquence de simulation**, ajouter jusqu’à 16 cibles, valider les trajectoires et jouer la séquence une fois. Le bail d’armement dure 20 secondes et peut interrompre une séquence longue.
6. **Annuler / désarmer** termine la simulation en cours et libère le poste. **STOP LOGICIEL** verrouille le poste. **Réinitialiser** permet ensuite un nouvel armement manuel.

## Kinétia

Kinétia est une expérimentatrice vive qui aime les trajectoires symétriques et les remarques sèches. Elle garde ses propres notes de préférence, consultables et effaçables dans le menu **Puce**. Ce menu permet aussi d’activer sa voix Phonon et de régler les alertes affichées dans Robotique. Elle signale un STOP, un mouvement incertain ou la perte du retour vidéo à partir de l’état du poste.

La puce ouvre une conversation privée par compte administrateur. Déplacez-la à la souris ou au doigt. Utilisez Alt et les flèches au clavier. Pincez la puce, utilisez Ctrl et la molette, ou ouvrez le menu **Puce** pour la redimensionner. La taille et la position sont enregistrées dans le navigateur.

1. Décrivez la trajectoire dans la conversation. Gemini Flash Lite peut proposer un titre et jusqu’à 16 poses absolues. Le brouillon indique sa pose de départ et ses angles en degrés.
2. Cliquez sur **Faire revoir par Gemini 3.6 Flash**. Ce modèle examine la demande, les étapes et les limites. En cas de refus, demandez une variante dans la conversation. Si le modèle est indisponible, le script reste en brouillon et la revue peut être relancée.
3. Lisez le script et l’avis du modèle, puis cliquez sur **Approuver cette version**. Le serveur lie les deux validations à cette version exacte et à la révision des réglages du poste.
4. Armez le simulateur et cliquez sur **Jouer en simulation**. Chaque étape passe par le contrôleur habituel. Le simulateur doit être à la pose de départ approuvée. Le STOP, le désarmement, la perte de focus et la sortie de la vue interrompent la lecture.

La puce utilise une icône neutre. Pour fournir votre propre portrait en mode adulte, placez un fichier WebP carré nommé `robotics-assistant-chip.webp` dans le dossier privé `.hq-agent-state` du pont. Le portrait personnalisé est servi au compte admin depuis le PC HQ lorsque le mode adulte est activé. Les autres affichages utilisent l’icône neutre.

Le chat utilise la configuration Gemini existante. Le texte de la conversation et les limites de mouvement nécessaires sont transmis au modèle. Les clés et les identifiants des appareils restent côté serveur. La lecture des scripts de l’assistant est réservée au simulateur.

## Tapo C200

1. Dans l’application Tapo, ouvrir la caméra, puis **Paramètres → Paramètres avancés → Compte caméra**. Créer le compte local dédié. Relever l’IPv4 LAN du C200 et la réserver dans le DHCP du routeur. [Guide RTSP/ONVIF TP-Link](https://www.tp-link.com/id/support/faq/2680/)
2. Sur Windows, extraire `go2rtc.exe` de l’archive officielle v1.9.13 adaptée à l’architecture du PC. Le placer dans `C:\Transfert\.hq-agent-state\go2rtc.exe` ou dans le PATH du processus HQ. Le SHA-256 de l’archive Windows x64 est `587a1757c7b25c38b0f1291a9413d2f873cd56a697547c7e9210b58abcce5611`. [Publication go2rtc v1.9.13](https://github.com/AlexxIT/go2rtc/releases/tag/v1.9.13)
3. Sur le PC HQ, ouvrir `http://127.0.0.1:8765/#robotique`. Dans les réglages, renseigner l’adresse de la caméra et le compte local, choisir la qualité par défaut et enregistrer. Un champ d’identifiant vide conserve sa valeur. **Effacer le compte caméra** efface les deux valeurs enregistrées.
4. Dans l’onglet **Caméra** du moniteur, choisir **Standard** (`stream2`) ou **Haute** (`stream1`) et cliquer **Démarrer le direct**. HQ ouvre le RTSP TCP sur le port 554, remuxe la piste H.264 et la sert sur l’origine HQ. Après une interruption, le poste tente une seule reconnexion. Changer de qualité après avoir coupé le flux. Le plein écran est disponible lorsque le navigateur lit des images. Revenir à **Position** coupe le direct et libère l’autorisation de pilotage physique.

La vidéo est réservée au PC HQ et aux connexions LAN directes via l’IPv4 de HQ. Utiliser Chrome ou Edge avec H.264/MSE. Safari nécessite Managed Media Source ou Media Source, le décodage H.264 et les callbacks vidéo. La latence de bout en bout nécessite une mesure avec une horloge visible dans le flux. Le moniteur indique la réception d’images et la latence aller-retour du RoArm. L’audio, ONVIF PTZ, l’enregistrement et les instantanés restent hors de cette intégration.

Le lecteur HQ existant sert des fichiers et des plages d’octets. Pour le direct, go2rtc remuxe sans transcodage et s’arrête lorsque la session vidéo se termine. WebRTC ajouterait la signalisation et la configuration ICE au déploiement Windows. Le chemin fMP4 utilise le cookie HQ et un unique flux HTTP, avec une fenêtre de lecture bornée. La passerelle locale est créée à la demande et seuls HQ et son relais RTSP y accèdent. Le relais refuse les redirections RTSP. [Formats go2rtc](https://github.com/AlexxIT/go2rtc/blob/master/pkg/README.md)

## RoArm-M2-S et mise en service physique

1. Fixer le bras et dégager le volume balayé. Installer une coupure d’énergie indépendante et accessible. Prévoir un support, un frein ou un dispositif adapté à la chute des axes lorsque le couple disparaît. Garder le bras en vue directe, même avec le Tapo actif.
2. Réserver l’IPv4 privée du RoArm. Isoler le contrôleur sur un réseau de confiance, sans redirection publique. Désactiver les missions de démarrage, les commandes concurrentes et le suivi ESP-NOW pendant les essais. Le firmware de référence peut déplacer le bras au démarrage du contrôleur lui-même. Vérifier ce comportement avant de mettre les servos sous tension.
3. Dans HQ sur le PC hôte, sélectionner **Matériel**, enregistrer l’IPv4 du bras et régler les limites, la vitesse, l’accélération et l’amplitude maximale d’un pas. L’interface initialise le profil pince stock. Elle ne reconfigure jamais le firmware. Le champ COM réserve une configuration pour un futur transport série.
4. Utiliser **Lire le RoArm**. Vérifier le retour `T:1051` et la cohérence des angles, du repère et des positions mesurées. Le firmware publié peut renvoyer une ancienne position de servo après un échec du bus. Confirmer le comportement sur l’unité réelle, avec accès à la coupure physique. Certains firmwares n’exposent le retour que par USB série. HQ refuse l’armement si le retour HTTP manque, est périmé ou ne correspond pas au profil.
5. Après inspection physique, depuis une console PowerShell sur le PC HQ, approuver la révision de configuration. La commande lit le fichier local et n’affiche aucun identifiant.

   ```powershell
   Set-Location C:\Transfert
   python -c "from pathlib import Path; from hq_robotics import Robotics, PROFILE; r=Robotics(Path.cwd()); c=r.config(); assert c['mode']=='hardware' and c['arm_ip'] and c['revision']; r.write(r.commission_path, {'revision':c['revision'],'profile':PROFILE})"
   ```

6. Démarrer la vidéo, armer le poste et valider un seul pas minimal. Vérifier le sens et l’échelle de chaque axe, la distance et la vitesse, le retour de la pince, l’arrêt logiciel et la coupure physique. Tester la perte de la caméra et de la liaison avec la zone dégagée. Chaque sauvegarde des réglages invalide l’approbation locale. Pour la retirer, supprimer `.hq-agent-state\robotics-commission.json`.

Les mouvements physiques passent par `T:102`, avec les angles en radians, la vitesse en pas/s et l’accélération en centaines de pas/s². HQ compare la cible à un retour obtenu juste avant l’envoi, borne chaque pas de 1 à 8° selon la configuration et vérifie l’enveloppe XYZ de référence en tenant compte des axes qui arrivent à des moments différents. La commande est sérialisée. HQ attend un retour proche de la cible avant d’afficher **Cible atteinte**. Une réponse HTTP vide au sens JSON (`{}`) signifie réception du transport. Le volume de la pince, les obstacles, la charge et les collisions réelles doivent être vérifiés lors de la mise en service. Le profil pince commande l’angle d’ouverture. Le mode poignet avec orientation indépendante nécessite un autre profil et une nouvelle calibration. [Firmware de référence](https://github.com/waveshareteam/roarm_m2/tree/c6ccc5bda2eb92df2f0850d3e63cc42b81557f4f/RoArm-M2_example), [commandes Waveshare](https://www.waveshare.com/wiki/RoArm-M2-S_JSON_Command_Meaning), [SDK Waveshare](https://github.com/waveshareteam/waveshare_roarm_sdk)

### Arrêt et reprise

- **Annuler / désarmer** libère l’autorisation et annule les prochaines entrées. Un pas physique déjà envoyé peut se terminer.
- **STOP LOGICIEL** verrouille HQ. Lors d’un mouvement physique en cours ou incertain, HQ demande la coupure du couple avec `T:210, cmd:0`. Cela peut laisser tomber un axe. Le firmware publié réactive le couple dix secondes après `T:0`, donc le poste utilise la commande de coupure du couple dédiée. La réception HTTP ne prouve pas l’arrêt mécanique.
- **Coupure physique** isole l’énergie sans dépendre de HQ, du Wi-Fi ou du firmware. Le poste n’active jamais le couple ni ne reprend un mouvement interrompu.
- Après une coupure de liaison ou un retour absent pendant un mouvement, vérifier le bras sur place avant **Réinitialiser**. L’état d’inspection est enregistré avant l’envoi et survit au redémarrage du bridge. Rétablir la disponibilité des servos suivant la procédure locale de mise en service, lire un retour récent et armer manuellement.

## Architecture et sécurité

- `iphone_bridge.py` expose le panneau et les routes sous les gardes HQ de session, d’admin, de Host et de CSRF. Il sert le flux vidéo sous la même origine.
- `hq_robotics.py` possède l’état du poste, le bail, le ticket consommable, les limites, l’historique et les préréglages. Une seule autorisation est active. Les valeurs secrètes sont omises des réponses. Les fichiers privés sont enregistrés sous `.hq-agent-state/` via `hq_state`.
- `hq_robotics_arm.py` porte le modèle et l’adaptateur HTTP. Les adresses RFC 1918 sont validées et épinglées à la configuration. Les hôtes ambigus, les URLs arbitraires et les commandes firmware brutes sont refusés.
- `hq_robotics_camera.py` confine la passerelle au loopback et lui transmet les identifiants via l’environnement du seul processus enfant. Le processus Windows est rattaché à la durée de vie du pont. Le navigateur reçoit des octets H.264/fMP4 et un identifiant de flux de courte durée.
- `assets/hq-robotics.js` et `assets/hq-robotics.css` sont chargés à l’ouverture. Le navigateur relâche l’autorisation sur perte de focus et libère les ressources vidéo en quittant la vue.

Un PIN administrateur actif figurait dans des documents suivis. Les occurrences de travail ont été retirées. Le propriétaire a choisi de conserver le PIN. Les révisions Git antérieures peuvent encore le contenir. Le pilotage physique exige une connexion directe depuis le PC HQ sur loopback, un enregistrement de mise en service écrit localement et une caméra active. Tailscale, Funnel et les clients LAN n’obtiennent aucun accès moteur. La simulation demeure disponible aux administrateurs.

## API

Toutes les routes commencent par `/api/robotics/`. Les POST prennent un objet JSON et les protections CSRF habituelles. Les GET authentifiés peuvent transmettre le bail dans l’en-tête `X-HQ-Robotics-Lease`. Les erreurs suivent le format HQ `{error, code}`.

| Méthode et route | Données et résultat |
|---|---|
| GET `status` | État, réglages publics, source du retour, cible, sécurité, historique et ticket pour le titulaire. Aucun appel matériel. |
| POST `settings` | Mise à jour partielle. Clés `mode`, `transport`, `arm_ip`, `serial_port`, `camera_ip`, `camera_user`, `camera_password`, `arm_timeout`, `camera_timeout`, `quality`, `speed`, `acceleration`, `step_limit`, `joint_limits`, `workspace`. PC HQ uniquement. |
| POST `telemetry` | Lecture physique explicite `{lease?}`. Lecture seule sur le RoArm. |
| POST `arm` | Renvoie un bail temporaire à transmettre aux commandes. |
| POST `move` | `{lease,ticket,kind,speed?,pose?,xyz?,id?}`. Types `joints`, `cartesian`, `home`, `preset`. Angles `{base,shoulder,elbow,hand}` en degrés, XYZ `{x,y,z,t}` en mm et degrés. |
| POST `cancel` | `{lease}`, libère l’autorisation du titulaire. |
| POST `stop` | Verrouille le poste et demande la coupure du couple si applicable. |
| POST `reset` | En matériel, `{inspected:true}` depuis le PC HQ. |
| POST `preview` | Résout et valide une cible sans la déplacer. Champs de cible de `move`. |
| GET, POST `presets` | Lire ou appliquer `{action:save|rename|delete,name?,id?,…cible}`. |
| POST `sequence` | `{steps:[…cibles]}` en simulation. Valide les segments successifs. |
| GET `assistant/thread` | Conversation, scripts et avis de revue du compte administrateur. |
| POST `assistant/message` | `{text}`, échange et proposition de poses validées par HQ. |
| POST `assistant/review` | `{id,digest}`, avis d’un modèle distinct et plus fort. |
| POST `assistant/approve` | `{id,digest,confirmed:true}`, approbation de la version ayant obtenu un avis favorable. |
| POST `move`, type `reviewed_script` | `{id,digest,index,lease,ticket}`. Exécute une seule étape du script enregistré en simulation à la vitesse approuvée. |
| POST `camera/start` | `{quality:standard|high}`, renvoie un identifiant de flux. |
| GET `camera/video` | Flux fMP4. En-tête `X-HQ-Robotics-Stream` lié à la session HQ. |
| POST `camera/frame`, `camera/stop` | `{stream}`, renouvelle la preuve de lecture ou coupe le flux. |

## Vérification

```powershell
python scripts/verify_bridge_smoke.py
$env:HQ_ROBOTICS_BROWSER = '1'
python -m unittest tests.test_hq_robotics tests.test_hq_robotics_http -v
```

Les tests utilisent un état temporaire, une session HQ de test, un firmware HTTP factice et une caméra simulée. Les limites de course, l’arrêt, les unités et la vidéo du C200 restent à vérifier avec les appareils réels.

Le test vidéo lance une source RTSP H.264 synthétique via FFmpeg et go2rtc, puis vérifie le décodage et la fermeture de la passerelle dans Chrome. Sur une machine qui utilise Edge, définir `HQ_ROBOTICS_H264_CHANNEL=msedge`.
