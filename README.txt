Transfert HQ v7 — Mission Control
=================================

Pont personnel (un opérateur) entre PCs Windows et iPhone, via LAN + Tailscale.
Python stdlib (ThreadingHTTPServer), état JSON local, interface HTML/CSS/JS.
Pas de SaaS. Le PIN reste obligatoire.

Architecture
------------
  iphone_bridge.py   HTTP, auth, CSRF, fichiers, routing
  cc_ext.py          ops stables (file, activité, shell allowlist, backup disque)
  hq_events.py       journal unifié borné
  hq_state.py        écriture JSON atomique (verrou, .tmp, fsync, os.replace)
  hq_automation.py   scènes / runbooks, règles, planning, backups, télémétrie, brief, push
  hq_calendar.py     événements manuels, projection des horaires, rappels
  hq_devices.py      modèle d'appareils et capacités (dérivées, pas inventées)
  hq_companion.py    registre companions, HMAC, politique (contrôleur)
  hq_jobs.py         file de travaux bornée (hq_agent_jobs.json)
  hq_agent_ops.py    catalogue d'opérations et risques
  hq_agent_protocol.py  signature, version de protocole, délais de poll
  companion_agent.py agent sortant sur un PC de confiance
  companion_ops.py   opérations bornées exécutées sur ce PC
  hqctl.py           client HTTP du planificateur (loopback seulement)
  hq_planner.py      API planificateur sur 127.0.0.1:8766
  assets/hq-agent.js centre agents (fiche Appareils)
  assets/hq.js       palette, bannière, aide contextuelle, journal, flotte, brief, voix, push
  assets/hq-calendar.js
  assets/hq-calendar.css
  assets/hq.css
  assets/hq-sw.js    service worker Web Push (opt-in)
  assets/qrcode.min.js

Les modules hq_* reçoivent des callbacks. Ils ne lancent pas de shell arbitraire
et n'importent pas le serveur HTTP (pas de cycle).

Companions (contrôle des autres PC)
------------------------------------
  Vieuxpeepee reste le contrôleur. Les PC de confiance lancent companion_agent.py.
  Le companion ouvre une connexion HTTPS sortante vers Tailscale Serve
  (poll 3 s quand un travail vient d'être traité, jusqu'à 15 s au repos,
  backoff borné en cas d'erreur). Pas de port entrant sur le PC géré.
  Pas de WebSocket. Pas de companion iOS : un iPhone reste un navigateur.

  Enrôlement : jeton à usage unique (15 min) créé dans Centre agents,
  échangé une fois contre un secret d'appareil. Le secret n'est plus
  renvoyé. Le jeton ne passe jamais en argument (historique, liste des
  processus) : sur le PC, lancer companion_agent.py avec --enroll seul,
  puis coller le jeton à l'invite (saisie masquée). Sans console, le
  fournir sur l'entrée standard depuis un fichier lisible par ce compte
  seulement, puis supprimer le fichier :
    Get-Content -Raw <fichier> | py -3 companion_agent.py --config ... --controller ... --enroll
  --enroll JETON (ou --enroll=JETON) est refusé sans afficher la valeur
  et sans contacter le pont : créer alors un nouveau jeton. La tâche
  planifiée n'enrôle jamais et ne reçoit que --config. Stockage : hq_agents.json sur le pont, agent_config.json
  sur le companion (ProgramData\TransfertHQ ou fichier local). Les deux
  sont gitignorés.

  Chaque requête signée porte X-HQ-Device, X-HQ-Time, X-HQ-Nonce,
  X-HQ-Signature (HMAC-SHA256, décalage ±90 s, nonce anti-rejeu).
  Les capacités effectives sont support ∩ plafond contrôleur ∩ politique
  de l'appareil. Une revendication du client n'accorde rien.
  Le terminal interactif n'est pas dans le plafond.

  Risques : lecture (file directe), sûr / sensible (direct si l'origine
  est un humain, sinon approbation), destructeur (toujours une approbation
  séparée). confirm:true n'approuve pas.

  hqctl est un client HTTP de 127.0.0.1:8766 (hq_planner.py). Il n'importe
  pas le registre ni la file. L'origine est forcée à planner ; un champ
  origin fourni est refusé. Le jeton planificateur (hq_planner.json) n'est
  ni le PIN, ni la session admin, ni un secret d'appareil. Le port public
  (8765, y compris derrière Tailscale Serve) répond 404 sur /local-agent.
  L'approbation humaine reste le navigateur admin + CSRF.

  Cette frontière est logicielle tant que les deux processus partagent un
  compte. Les secrets du companion sont dans <pont>\.hq-agent-state\
  (hq_agents.json, hq_agent_jobs.json, hq_planner.json). Les artifacts
  restent dans Inbox\AgentArtifacts. Au premier démarrage, un fichier
  encore à la racine est déplacé une fois si la destination est absente.
  Si les deux copies existent, HQ s'arrête sans en choisir une.
  L'écriture atomique crée <nom>.tmp dans ce répertoire : le fichier
  hérite de l'ACL du répertoire avant os.replace.

  Arbre du pont, en élevé, avant l'état privé. Le propriétaire visé est le
  SID S-1-5-32-544 (BUILTIN\Administrators, ou BUILTIN\Administrateurs sur
  un Windows français). Le script traduit ce SID ; il n'écrit pas le nom
  anglais en dur. Un objet laissé à Everyone peut réécrire sa DACL.
  Le planificateur n'est jamais propriétaire. Sur StateDir il a seulement
  le droit de traverser, non héritable. Les fichiers inconnus restent donc
  privés du contrôleur (Modify héritable). ReadAndExecute explicite, et
  seulement ça, pour hqctl.py. hqctl n'importe aucun module du dépôt :
  il calcule lui-même le chemin du jeton. hq_state.py reste privé du
  contrôleur. Invocation : py -3 -B C:\Transfert\hqctl.py
  bridge_config.json et bridge_sessions.json n'héritent pas : pas de
  lecture planificateur. Les autres fichiers d'identifiants (hq_vapid.json,
  clés, agent_config.json) restent privés parce que l'accès planificateur
  n'est pas hérité. Seul <StateDir>\.hq-agent-state (chemin complet) est
  laissé à install_hq_state_acl.ps1. Un autre dossier nommé .hq-agent-state
  ailleurs dans l'arbre reçoit la politique de l'arbre (ACE explicites
  retirées, héritage rétabli) ; s'il garde une ACE explicite ou un héritage
  coupé, le script s'arrête sans déclarer l'arbre durci.
  .git est inclus : propriétaire et ACL seulement, octets / refs / config /
  hooks / index inchangés. Un point de réparation est signalé par son chemin
  et le script s'arrête avant toute écriture, sans suivre la cible.
  La tâche TransfertBridge n'est pas réenregistrée ; son principal reste
  le compte contrôleur.
  -WhatIf affiche les lignes PRÉVU et n'appelle ni SetOwner, ni AddAccessRule,
  ni Set-Acl. Propriétaire, ACL et octets restent inchangés :
    powershell -ExecutionPolicy Bypass -File .\install_hq_tree_acl.ps1 -WhatIf `
      -StateDir C:\Transfert `
      -ControllerIdentity "VIEUXPEEPEE\autm_" `
      -PlannerIdentity "VIEUXPEEPEE\hq-planner"
    powershell -ExecutionPolicy Bypass -File .\install_hq_state_acl.ps1 -WhatIf `
      -StateDir C:\Transfert `
      -ControllerIdentity "VIEUXPEEPEE\autm_" `
      -PlannerIdentity "VIEUXPEEPEE\hq-planner"
  Puis, sans -WhatIf, le même StateDir et les mêmes identités. L'état privé
  après un premier démarrage (répertoire et jeton présents).
  Le répertoire privé donne FullControl héritable à SYSTEM et Administrators,
  Modify héritable au contrôleur, et au planificateur seulement le droit
  de traverser (non héritable). Propriétaire : BUILTIN\Administrators.
  hq_planner.json reçoit en plus Read explicite pour le planificateur.
  hq_agents.json, hq_agent_jobs.json et les *.tmp n'ont pas de grant
  planificateur. Un *.tmp créé ensuite peut appartenir au contrôleur :
  le planificateur n'en est pas propriétaire.
  hqctl, sous le compte planificateur, lit
  <pont>\.hq-agent-state\hq_planner.json par défaut. Le script refuse
  deux identités identiques, ou un planificateur Administrator / SYSTEM.
  Un planificateur membre du groupe Administrateurs peut quand même lire
  l'état : ne pas appeler ça une séparation.

  Contrat après application, pour le planificateur : traverser C:\Transfert,
  lire/exécuter hqctl.py, lire hq_planner.json, joindre 127.0.0.1:8766.
  Aucun autre fichier Python du dépôt n'est lisible, y compris hq_state.py.
  Pas lister ni lire le reste de l'arbre, pas lire la config,
  les sessions, les agents, les travaux, vapid ou les clés, pas modifier le
  code, .git, une DACL via un propriétaire Everyone, ni TransfertBridge,
  pas approuver un travail.

  Vérification Windows des ACL (sur le pont, avant d'enrôler un second PC) :
  1. Démarrer HQ une fois pour créer .hq-agent-state et le jeton.
  2. Lancer d'abord les deux scripts avec -WhatIf, puis sans -WhatIf.
     Le second script seul durcit .hq-agent-state.
     Get-Acl : propriétaire S-1-5-32-544 (Administrateurs sur ce Windows),
     plus Everyone.
     Get-Acl sur hqctl.py : planificateur ReadAndExecute.
     Get-Acl sur iphone_bridge.py et sur .git : pas de lecture planificateur.
     Get-Acl sur bridge_config.json et bridge_sessions.json : pas de lecture
     planificateur. Get-ScheduledTask TransfertBridge : principal inchangé.
  3. Get-Acl sur le répertoire privé, hq_agents.json, hq_agent_jobs.json,
     hq_planner.json. Propriétaire BUILTIN\Administrators.
  4. Déclencher une écriture (créer puis ignorer un jeton d'enrôlement).
  5. Get-Acl sur hq_agents.json : toujours contrôleur seulement, après
     le remplacement atomique.
  6. Créer un travail planificateur anodin pour réécrire hq_agent_jobs.json.
     Get-Acl : le planificateur ne doit toujours pas pouvoir le lire.
  7. Sous PlannerIdentity : py -3 -B C:\Transfert\hqctl.py devices --json
     fonctionne. Échoue : Get-ChildItem C:\Transfert ; Get-Content de
     iphone_bridge.py, hq_state.py, bridge_config.json, bridge_sessions.json,
     .hq-agent-state\hq_agents.json et .hq-agent-state\hq_agent_jobs.json.
     Modifier hqctl.py échoue.

  Bail : poll pose l'état leased, un dispatch_token et lease_until (30 s).
  expires_at est le délai d'attente avant le démarrage. Au POST
  /agent/v1/start, HQ pose started_at et
  run_deadline = started_at + timeout_sec + 15 s. Résultat et artifact ne
  sont acceptés qu'en état running avec le même jeton, et avant
  run_deadline. Une requête start, result ou artifact arrivée après
  run_deadline règle d'abord le travail sous le verrou (même règle que le
  balayage, même sans balayage), puis est refusée. Bail expiré avant
  start : une lecture peut revenir en file (3 essais au plus). Après start,
  plus aucune relance. Si le résultat manque : une lecture devient failed
  (« résultat non reçu ») ; sûr, sensible et destructeur deviennent
  uncertain (« résultat non reçu après démarrage »). Le jeton est effacé.
  Un artifact déjà enregistré est conservé. attempts et started_at restent.

  Identité : l'IP ou le hostname déclarés sont des diagnostics
  (reported_ips, reported_hostname). Ils ne lient pas un companion à un
  pair Tailscale. Lien explicite : POST /api/agent action=link (admin).
  Tant qu'il n'y a pas de linked_peer_id, le companion est sa propre ligne.
  Un téléphone ne devient jamais un companion, même si l'id lié correspond.

  Artifacts : authorize_artifact ne crée aucun fichier. Ensuite réserve
  disque (upload_disk_reserve_gb, défaut 2 Go) et quota par appareil.
  Écriture *.partial, fsync, os.replace. Si le rattachement échoue, le
  fichier est supprimé. Aucun lien n'est suivi : un lien symbolique, une
  jonction ou un autre point de réparation dans
  Inbox\AgentArtifacts\<appareil>\<travail> refuse l'artifact. Le *.partial
  est créé en exclusif (O_CREAT|O_EXCL, O_NOFOLLOW si disponible) ; un
  *.partial ou un nom final déjà présent refuse l'envoi. Seuls les fichiers
  créés par la requête sont supprimés. Seuls fs.stage et screenshot.capture produisent
  un artifact.

  Nonce : le cache anti-rejeu est en mémoire. Après un redémarrage du
  pont, une requête signée capturée peut être rejouée tant que son
  horodatage reste dans ±90 s. TLS protège le trafic habituel.

  Routes companion : POST /agent/v1/enroll|heartbeat|poll|start|result|artifact
  Routes admin (cookie admin + CSRF, pas le rôle upload) : /api/agent
  Routes planificateur (127.0.0.1:8766, Bearer) : /local-agent/v1/devices|jobs

  Installation Windows : install_companion.ps1 pose une DACL protégée
  (héritage retiré, DACL remplacée en entier) par SID seulement :
  S-1-5-18 et S-1-5-32-544 en contrôle total, SID de l'identité Windows
  courante en modification. Elle couvre le dossier, work, agent_config.json,
  le code copié et tout objet déjà présent ; une ancienne ACE Users,
  Everyone ou autre disparaît. Un point de réparation dans l'arbre arrête
  l'installation avant toute écriture. Chaque objet est relu et vérifié
  par SID (protégé, propriétaire, SID autorisés, droits, présence). Un
  échec d'écriture ACL ou de vérification arrête l'installation avant la
  tâche. La tâche visible au logon ne reçoit que --config. Le script
  affiche l'étape d'enrôlement avec --enroll seul (saisie masquée).
  uninstall_companion.ps1 retire la tâche et garde les secrets sauf
  -DeleteData. Protocole version 1.

  SSH existant reste disponible et distinct (badge SSH). Agent HQ est
  un autre canal. Le shell interactif du pont n'est pas devenu un
  shell permanent pour l'agent.

Accueil
-------
  État HQ (ok / attention / critique) → aujourd'hui → envoyer → appareils
  → activité récente (filtres Envois / Opérations).
  Le journal technique reste disponible sous Plus / Système, fermé
  par défaut. Les événements ne sont pas supprimés.
  Les cartes HQ et Aujourd'hui sont repliées par défaut (localStorage
  hq_home_attention_open et hq_home_today_open). Un état critique ouvre
  HQ, sans réécrire ce choix. Le compteur critique ne compte que les
  éléments de niveau critique (les autres restent « autres »).
  Recherche reste visible à côté du résumé.
  Le prochain événement reste dans l'en-tête d'Aujourd'hui : l'heure
  ou la date courte reste entière, le titre est la partie qui se coupe.
  Un rafraîchissement ne rouvre pas une carte refermée.
  À partir de 1160px, ces deux cartes sont côte à côte. En dessous,
  elles restent l'une sous l'autre. Jusqu'à 430px, le compteur
  d'attention passe sous le titre pour que l'état reste lisible.
  Ctrl+K ou « / » (hors champ) ouvre la palette. Elle ne lance qu'une cible
  allowlist (dossier, favori, scène, action, commande par id, fiche appareil).
  Requête vide : récents locaux (hq_palette_recents : kind, id, label, hint)
  et favoris déjà chargés. L'exécution repasse par les mêmes endpoints.
  Le tri des fichiers (hq_files_sort) reste dans le navigateur.

Routes ajoutées (admin ; le rôle upload reste sur son allowlist)
----------------------------------------------------------------
  GET  /api/hq                  instantané (cache appareils / disques, pas de probe Tailscale)
  GET  /api/events              journal ?kind&level&q&since&limit&offset
  GET  /api/device?id=          fiche + gates de capacités
  GET  /api/palette?q=          recherche floue (jamais le texte d'une commande)
  GET  /api/runs                reçus d'exécution de scènes
  GET  /api/automation          règles
  POST /api/automation          {action: save|delete|enable|run, ...}
  GET  /api/schedules           jobs daily|weekdays|weekly|once|on-online
  GET  /api/calendar            ?from=&to= (fin exclue, max 366 jours) &include_activity=0|1
  POST /api/calendar            {action: save|delete, expected_rev, event|id}
  POST /api/calendar/run        {id, target: scene|action} — jamais appelé par l'horloge
  POST /api/queue               étendu : ces when + at HH:MM, weekday 0=lundi, once_at, device_id
  GET  /api/backups             catalogue
  POST /api/backup/restore      {id, folder: Inbox|Uni|Print, confirm: true}
  GET  /api/telemetry?device=   séries pour sparklines (pas de lib de graphiques)
  GET  /api/brief               brief déterministe
  POST /api/brief               {action:"discord"} seulement si webhook ET daily_brief_discord
  GET  /api/push/status         clé publique + rappel HTTPS
  POST /api/push/subscribe      opt-in
  POST /api/push/unsubscribe
  POST /api/push/test           nécessite pywebpush
  GET  /hq-sw.js                service worker (Service-Worker-Allowed: /)

Les routes historiques (fichiers, upload, shell, scènes, wallboard, …) restent.

Scènes / runbooks (steps)
-------------------------
  explore, action, terminal (id allowlist seulement), backup, capture, print,
  notify, wait (≤10 s/étape, ≤30 s/run), move, scene, condition
  (disk_ok | device_online | file_exists).
  stop_on_failure vrai par défaut. Profondeur max 3. Budget 64 étapes.
  Reçus dans hq_runs.json.

Planning
--------
  when : online | wake | now (existant) | daily | weekdays | weekly | once | on-online.
  Pas de cron libre. Garde une exécution par minute.
  terminal planifié : cmd_id allowlist. Champ command/cmd/shell/host refusé.
  daily / weekdays / weekly mémorisent next_run (minute locale YYYY-MM-DDTHH:MM).
  Si HQ était arrêté, un seul créneau en retard est rattrapé, dans une fenêtre
  de 12 h (CATCHUP_WINDOW_SEC). Les périodes plus anciennes sont sautées :
  pas de rejeu d'un backlog. Un job sans next_run ne rattrape pas un créneau
  antérieur à sa création ; il part au prochain créneau, ou tout de suite si
  la minute courante correspond.

Calendrier
----------
  Onglet Calendrier : Jour, Semaine (lundi), Mois, Agenda.
  Mois : une pastille tronquée sous 700px, deux au-dessus, puis +N.
  Le titre ne déborde pas sur la case voisine.
  Téléphone : Jour par défaut. Grand écran : Semaine. Le dernier choix
  et le bouton Activité sont mémorisés dans le navigateur.
  Heure HQ locale, 24 h, français (fr-CA). Si le fuseau du navigateur
  diffère, la barre indique « Heure HQ ».
  Événement manuel : titre, journée entière (fin exclue), catégorie,
  lieu, notes, rappels (au plus 3). Liens optionnels vers une scène,
  une action, ou un appareil (l'appareil ouvre seulement sa fiche).
  Les horaires daily / weekdays / weekly / once sont projetés depuis
  bridge_queue.json. Ils ne sont pas copiés dans hq_calendar.json.
  Un horaire récurrent ne commence pas avant sa création : un daily
  08:00 créé à 10:00 apparaît le lendemain à 08:00, pas le matin même
  ni les mois précédents. online, wake et on-online restent dans la
  section Conditionnel, hors de la grille. La projection ne modifie
  pas la file.
  Une scène ou une action liée est refusée à l'enregistrement si elle
  n'est pas dans le catalogue, puis revérifiée au lancement.
  Révision attendue (expected_rev) : un conflit répond 409.
  Plafond d'environ 2000 événements. Pas de récurrence manuelle.
  L'horloge ne lance jamais une scène ou une action liée. Seul
  POST /api/calendar/run le fait, après confirmation dans l'interface.
  Rappels : une fois, identité événement|début|délai. Une modification
  du début invalide l'ancienne identité. Rattrapage de 5 minutes,
  au-delà le rappel est sauté. Journée entière : ancre à 08:00 HQ
  le jour de début (0 = 08:00 ce jour-là, 1440 = 08:00 la veille).
  L'alerte reste dans HQ (journal et Web Push). Discord n'est pas appelé.
  Les pastilles d'activité portent l'heure HQ (local_at), pas le fuseau
  du navigateur. L'onglet ouvert se rafraîchit environ toutes les 45 s
  tant qu'il est visible. La vue Jour d'aujourd'hui défile près de
  l'heure courante.
  GET /api/hq ajoute calendar.today (5 éléments) et calendar.next
  sans sonder Tailscale. L'accueil affiche Aujourd'hui / Prochain.
  Le wallboard n'affiche que la carte Prochain.
  Les routes calendrier sont admin. Elles ne sont pas sur l'allowlist
  du rôle upload. Les POST exigent le contrôle CSRF habituel.

Interaction et accessibilité
----------------------------
  Tokens : --tap-min 44px, --text-xs 0.75rem, --text-sm 0.82rem,
  --text-base 1rem, --focus-ring. Le texte interactif reste vers
  0.80rem ou plus. Le thème clair utilise #08724f pour l'accent
  (environ 5.95:1 sur blanc, texte blanc sur ce fond aussi).
  Le thème sombre Mission Control ne change pas.
  Une catégorie de calendrier se lit par une couleur ET une forme
  (pastille, carré, losange, contour, capsule). Un horaire HQ est
  en outre en bordure pointillée et porte « Lecture seule ».

  Survol : uniquement @media (hover:hover) and (pointer:fine).
  Bordure un peu plus claire, fond léger, parfois translateY(-1px).
  Pas de survol sur un contrôle désactivé. Pas de rebond ni de halo.

  Clavier : :focus-visible dessine outline 2px var(--accent),
  offset 2px. Le focus n'est pas retiré sans remplacement.

  Aide : un contrôleur dans assets/hq.js, un seul #hq-help-tooltip.
  data-help="…" sur les contrôles où une phrase aide vraiment
  (statut, mode, recherche, verrouiller, veille, capture, dossier,
  captures, vues du calendrier, activité, nouvel événement, horaires
  en lecture seule). Pointeur fin : pointerover en délégation
  (relatedTarget ignore le déplacement dans le même contrôle, comme
  pointerenter) démarre 2 s ; toujours sur la même cible → affichage ;
  départ avant 2 s → annulation ; départ après affichage → masquage
  immédiat. Aussi masqué au clic,
  au défilement, à Échap, au changement de vue et à l'ouverture d'une
  feuille. Clavier : environ 250 ms après le focus, sans les 2 s.
  Tactile : pas de survol simulé, pas d'aide au premier tap, pas
  d'appui long. L'essentiel est dans le libellé, aria-label ou la
  feuille de détail.
  role=tooltip, pointer-events:none, max-width 300px, texte en
  textContent (jamais innerHTML). aria-describedby pointe vers
  l'infobulle seulement pendant qu'elle est visible. Elle ne prend
  pas le focus et n'est pas la seule source d'une information
  essentielle. Pas de PIN, jeton, commande ni URL de webhook.
  Le survol d'un événement (2 s, pointeur fin) résume le titre,
  l'horaire, la catégorie ou « lecture seule », et « Lié » s'il
  y a une scène ou une action. Les notes privées n'y sont pas.

  Flèches du calendrier : aria-label « Jour/Semaine/Mois/Agenda
  précédent/suivant ». Supprimer est un bouton danger (contour),
  avec la même confirmation qu'avant.

  Navigation : petites icônes SVG currentColor, avec le texte.
  Téléphone : Plus. Bureau (≥900px) : Système. data-nav reste "plus".
  Le titre du document suit la vue.

  Opérations longues : withBusy / la ligne « … » déjà présente
  (capture, sauvegarde, restauration, shell, envoi, impression,
  archivage, tri, nettoyage, scène, enregistrement calendrier).
  Pas de fausse barre de progression.

  prefers-reduced-motion: reduce coupe le pulse et les transitions
  non essentielles.

  Fiche appareil (<dialog>), palette et feuilles calendrier :
  focus à l'ouverture, Échap ferme, le focus revient à l'ouvreur,
  role=dialog et aria-modal. Tabulation bouclée localement, sans
  librairie.

  Limites connues : sur un pointeur grossier, un événement court
  de Jour ou Semaine élargit sa zone de tap dans le temps libre,
  jusqu'à 44px, en s'arrêtant à mi-chemin du voisin. La barre colorée
  reste sur la durée réelle. Deux événements collés ne s'élargissent
  pas et peuvent rester sous 32px. Les pastilles du mois et « +N »
  font 32px pour garder la grille. Les marqueurs d'activité de la
  semaine font 24px (ceux du jour occupent la gouttière, 44px).

Contrôle sur un appareil réel
-----------------------------
  Non exécuté dans cet environnement sur iPhone, Safari iOS ou un
  poste Windows. À faire sur le pont :
  1. Largeurs ~390, ~430, 768, 1280 : pas de défilement horizontal
     de la page. La semaine, elle, défile.
  2. Mois, titre très long : une ligne coupée, puis +N. Téléphone :
     une pastille. Bureau : deux.
  3. Tap sur un contrôle : pas d'infobulle. Tab : infobulle rapide.
     Bureau : infobulle après ~2 s, masquée par Échap, clic, scroll.
  4. Thème clair et sombre. Supprimer reste rouge et confirme encore.
  5. Plus (téléphone) / Système (bureau). Journal technique fermé.
  6. Capture, sauvegarde, shell : la ligne d'attente s'affiche.

Règles
------
  Déclencheurs : manual, event (kind), device_online, disk_low.
  Actions : notify, scene, journal, backup, terminal (id), capture.
  cooldown_sec min 30. Master switch : automation_enabled.
  device_online est un front offline → online, pas un niveau. Le premier
  échantillon sert de référence (un redémarrage pendant que l'appareil est
  déjà en ligne ne lance pas la règle). Rester en ligne ne relance pas après
  le cooldown. Un front pendant le cooldown est mémorisé et part une fois
  le cooldown écoulé, si l'appareil est encore en ligne.
  Une règle event pose rule_id et run_id sur les événements qu'elle produit
  (journal, scène). Ces descendants sont ignorés. Un curseur event_cursor_id
  avance après le traitement : le cooldown seul ne suffit pas. disk_low reste
  un niveau borné par le cooldown.

Fichiers d'état (gitignorés — tolérer l'absence ; ne pas écraser un JSON cassé)
--------------------------------------------------------------------------------
  hq_events.json
  hq_calendar.json
  hq_automation.json
  hq_runs.json
  hq_telemetry.json
  hq_backup_index.json
  hq_push_subscriptions.json
  hq_vapid.json          clé privée Web Push — ne jamais committer
  .hq-agent-state/       secrets companions et jeton planificateur
    hq_agents.json       secrets — ne jamais committer
    hq_agent_jobs.json   file des travaux (contient le dispatch_token)
    hq_planner.json      jeton du planificateur — ne jamais committer
                         un fichier encore à la racine est migré une fois
                         si la copie privée est absente ; les deux ensemble
                         bloquent le démarrage
  agent_config.json      secret du companion, sur le PC distant
  bridge_config.json     PIN / webhook — ne jamais committer
  bridge_sessions.json
  bridge_queue.json      verrou RLock sur toute transaction load→save, écriture atomique.
                         Un JSON illisible ou non-liste est conservé.
  + les fichiers v6 déjà gitignorés (activity, kanban, scratchpad, …)

Le brief Discord met à jour last_brief_date sous le verrou automation, après
relecture. L'envoi Discord (thread) n'est pas fait sous ce verrou. disk_low
reste un niveau : il peut repartir après le cooldown tant que le disque est bas.

Clés de config nouvelles (dans bridge_config.json, pas de secret)
------------------------------------------------------------------
  automation_enabled       défaut true
  schedules_enabled        défaut true
  daily_brief_discord      défaut false (ET discord_webhook_url non vide)
  push_enabled             défaut false
  telemetry_local_sec      30–60, défaut 45
  telemetry_remote_sec     120–600, défaut 180
  telemetry_retain_hours   24–48, défaut 36

Télémétrie : l'échantillon local vient du cache disque déjà connu.
Les pairs Tailscale ne sont pas re-sondés à chaque GET /api/hq.

Disque surveillé et backups
---------------------------
  Alerte « Espace disque bas » : volume de la racine HQ (ROOT, ex. C: pour
  C:\Transfert), seuil alert_disk_min_gb. Une alerte par passage sous le seuil,
  réarmée quand l'espace repasse au-dessus. Un volume illisible donne une seule
  alerte « Disque introuvable » (jamais traité comme « OK »).
  Santé : /api/health → disk_root (volume principal, avec "volume"), disk_d
  conservé pour compatibilité (missing:true si D: absent) ; /api/status →
  disk_transfert (volume racine, principal) et disk_d ; l'appareil pc-host
  affiche d'abord le volume racine.
  backup_dir : défaut D:/Backups/Transfert, volontairement PAS le volume de la
  racine (un backup sur le même disque ne protège pas d'une panne). Si le
  lecteur est absent ou le chemin non absolu, le backup échoue explicitement :
  erreur 500 sur POST /api/backup, une alerte « Backup impossible » pour le
  backup planifié (réarmée après un backup réussi), avertissement au démarrage,
  et /api/health → backup.ok=false. Choisir un autre disque : régler backup_dir.
  Limite : seule la PRÉSENCE du lecteur (et un chemin absolu) est vérifiée.
  Un volume présent mais en mauvais état ou inadapté n'est PAS détecté — par
  ex. le D: du contrôleur (clé USB FAT32 « Full Repair Needed », FAT32 refuse
  les fichiers > 4 Go) : un pont non mis en pause y écrirait quand même. Une
  cible présente mais défaillante doit être mise en pause explicitement
  (backup_auto_paused, ci-dessous) ou remplacée via backup_dir.

  Pause des backups automatiques : "backup_auto_paused": true
    Suspend TOUS les backups automatiques (planning backup_every_hours du pont,
    et les étapes/actions « backup » des planifications, règles et scènes
    d'automatisation) : aucune écriture, aucun accès à backup_dir, aucune
    alerte répétée. Le bouton « Faire une sauvegarde » (POST /api/backup) reste
    disponible et échoue toujours clairement si la cible est inutilisable.
    Visible : /api/health → backup.auto_paused=true (+ note), /api/status →
    backup_auto_paused=true, ligne santé « Backup auto en pause », et au
    démarrage « Backup : PAUSE (backup_auto_paused) ».
    Défaut : false (une nouvelle installation garde ses backups planifiés).
    Ce défaut ne protège PAS contre une cible présente mais défaillante : sur
    une telle machine, la pause doit être mise explicitement.
    Les backups déjà présents sur D: ne sont ni déplacés ni supprimés.
    Pas de contournement par un grand backup_every_hours : _last_backup vaut 0
    au démarrage et l'intervalle ne s'applique qu'après un backup réussi, donc
    le premier backup planifié part quand même au démarrage du pont.

    Déploiement sur le contrôleur (à faire soi-même, dans cet ordre) :
      1. Arrêter le pont.
      2. Pont arrêté : installer le code relu (cette version) ET, dans
         C:\Transfert\bridge_config.json, ajouter au niveau racine :
           "backup_auto_paused": true,
         (pont arrêté : une sauvegarde de config par le pont en marche
         écraserait la modification ; une ancienne version du code ignore
         cette clé et lancerait le premier backup planifié au démarrage.)
      3. Redémarrer le pont.
      4. Vérifier /api/health → backup.auto_paused: true (ou la ligne de
         démarrage « Backup : PAUSE (backup_auto_paused) »).
    Pour reprendre (après avoir validé une nouvelle cible, voir ci-dessous) :
    remettre false (ou retirer la clé) pont arrêté, puis redémarrer.

  Avant de s'appuyer sur une nouvelle cible (disque externe NTFS, NAS) :
    - Vérifier le système de fichiers (PowerShell : Get-Volume -DriveLetter E →
      FileSystem NTFS ; FAT32 refuse les fichiers > 4 Go).
    - Régler backup_dir, redémarrer, lancer « Faire une sauvegarde » : la
      réponse indique le dossier <backup_dir>\<AAAAMMJJ_HHMMSS>.
    - Relire le backup SANS restaurer sur la racine (la restauration HQ écrase
      Inbox|Uni|Print) : comparer les empreintes, par ex.
        $src = "C:\Transfert\Inbox"; $dst = "E:\Backups\Transfert\<id>\Inbox"
        $h = { param($r) Get-ChildItem $r -Recurse -File | ForEach-Object {
               "{0}|{1}" -f $_.FullName.Substring($r.Length), (Get-FileHash $_.FullName).Hash } }
        Compare-Object (& $h $src) (& $h $dst)    # aucune sortie = identique
      (les fichiers .tmp / *.pid sont exclus du backup ; un fichier modifié
      depuis le backup apparaîtra aussi) et ouvrir quelques fichiers copiés
      vers un dossier temporaire. La liste des backups catalogués est dans
      GET /api/backups (Système → Sauvegardes).

Notes vocales
-------------
  Bouton « Note vocale » (MediaRecorder) → upload existant vers Inbox/Voice/.
  Mêmes quotas / dossiers / CSRF que les autres envois.

Web Push (opt-in, périmètre limité)
----------------------------------
  Ce n'est pas un bus de toutes les notifications HQ.
  Avec push_enabled et au moins un abonnement, send_push envoie seulement :
    - alert            (journal d'activité kind=alert)
    - attention        (points d'attention de niveau critique, une fois chacun)
    - automation_failure (échec d'une action de règle)
  POST /api/push/test réutilise ce même envoi (catégorie alert).
  Un endpoint qui répond 404 ou 410 est retiré des abonnements.
  La clé privée VAPID n'est ni renvoyée par l'API, ni écrite dans les logs.
  1. HTTPS obligatoire. Le HTTP :8765 nu ne suffit pas pour un iPhone.
     Préférer Tailscale Serve :
       tailscale serve --bg --https=443 http://127.0.0.1:8765
     Puis public_base_urls: ["https://TON-MACHINE.TAILNET.ts.net/"]
  2. push_enabled: true
  3. pip install cryptography   (génération VAPID si hq_vapid.json absent)
     pip install pywebpush      (envoi ; sans ce paquet, l'abonnement se stocke
                                 mais l'envoi répond que pywebpush manque)
  Aucun service cloud n'est contacté tant que tu n'abonnes pas un navigateur.
  L'envoi va uniquement vers l'endpoint push du navigateur (VAPID).

Migration depuis v6
-------------------
  Même processus, même PIN, mêmes dossiers Inbox/Uni/Print.
  Les scènes v6 (explore / action) passent par le runner v7.
  La file « au réveil » (when=online) est inchangée.
  Aucune migration de base : les JSON hq_* sont créés au premier usage.
  Un JSON hq_* illisible est laissé tel quel (les lectures renvoient malformed).
  Écriture des sept fichiers v7 : verrou par chemin, sérialisation dans un
  frère *.json.tmp, flush, fsync, os.replace. Un fichier cassé n'est pas
  remplacé. Les *.json.tmp sont gitignorés.

Commandes
---------
  python -m unittest discover -s tests -v
  python -W error::SyntaxWarning -m py_compile iphone_bridge.py cc_ext.py hq_events.py hq_devices.py hq_automation.py hq_calendar.py hq_state.py hq_companion.py hq_jobs.py hq_agent_ops.py hq_agent_protocol.py companion_agent.py companion_ops.py hqctl.py hq_planner.py

Contrôle manuel du calendrier
-----------------------------
  Non exécuté ici sur Windows, iPhone ou Tailscale.
  À faire sur le pont réel :
  1. Ouvrir Calendrier. Téléphone : Jour. Bureau : Semaine.
  2. Créer un horaire et une journée entière. Les revoir en Mois et Agenda.
  3. Ajouter un job daily. Il s'affiche en lecture seule. bridge_queue.json
     ne gagne pas de copie dans hq_calendar.json.
  4. Confirmer « Lancer la scène ». Un rappel ne doit pas la lancer seul.
  5. Compte upload : /api/calendar répond 403.


SECURITY INVARIANTS
-------------------
  Auth
    - PIN obligatoire. Sans pin ni users[].pin, le processus refuse de démarrer (fail closed).
    - Un PIN vide à l'exécution n'authentifie personne : pas d'admin implicite.
    - Loopback (127.0.0.1) n'est jamais admin. Cookie de session requis.
    - Rôles admin | upload. Toute route nouvelle est admin tant qu'elle n'est pas
      dans l'allowlist upload (serveur, pas l'UI).
    - Changement de PIN / users : auth_generation invalide les sessions.
    - Cookie HttpOnly, SameSite=Lax, Secure derrière X-Forwarded-Proto=https.
    - Le PIN n'apparaît ni dans le HTML, ni dans les QR, ni dans les logs,
      ni dans l'API, ni dans Discord, ni dans les URL.

  CSRF
    - Origin ou Referer obligatoire sur POST/PUT/PATCH/DELETE cookie, sur /login,
      et sur les GET qui mutent encore (/logout, /api/inbox?clear=1).
    - Pas de nouveau GET mutant. Pas de contournement Bearer.

  Fichiers
    - Résolution sous Inbox|Uni|Print uniquement, via parse_rel / resolve_rel.
    - Pas de concaténation d'un chemin utilisateur. Traversal (..) rejeté.
    - Contenu actif (html, svg, js, …) forcé en téléchargement + nosniff.
    - Quotas d'upload : sessions simultanées, réserve disque, taille, chunks
      contigus, index borné, TTL.
    - Restauration : id YYYYMMDD_HHMMSS, dossier Inbox|Uni|Print, sous backup_dir,
      écriture seulement sous la racine du pont, confirm JSON true obligatoire
      (un texte truthy ne suffit pas). Le nombre de fichiers est compté avant
      toute copie ; au-dessus de 5000, rien n'est appliqué.

  Exécution distante
    - Pas de surcharge d'hôte SSH (champ host refusé). Cibles = shell_targets / pairs connus.
    - Companion : auth HMAC, capacités calculées côté pont, travaux explicites.
      Pas d'écoute publique, pas de RPC anonyme, pas de shell permanent pour l'IA.
      iOS refusé à l'enrôlement. Terminal interactif hors plafond.
      Alimentation restart/shutdown : risque destructeur, TTL court, et le
      companion Windows ne l'exécute que si destructive_power_enabled est vrai.
      Presse-papiers désactivé tant que clipboard_enabled n'est pas vrai.
      Le planificateur n'est pas sur le port public. hqctl ne peut pas
      approuver. Deux comptes distincts, install_hq_tree_acl.ps1 (propriétaire
      BUILTIN\Administrators, traverse non héritable, ReadAndExecute seulement
      sur hqctl.py) puis install_hq_state_acl.ps1 sont
      nécessaires pour une séparation OS.
      Un même compte, ou un planificateur administrateur, peut lire les secrets.
      Les fichiers privés sont sous .hq-agent-state ; l'ACL durable est celle
      du répertoire, héritée par les *.tmp avant os.replace. Le propriétaire
      de ce répertoire est BUILTIN\Administrators, pas Everyone.
      Artifact : autorisation avant écriture, réserve disque, pas d'orphelin.
      Bail avant start, puis run_deadline. Un résultat manquant après start
      n'est failed que pour une lecture. Le reste est uncertain, sans relance.
      Pas de lien automatique pair/companion.
      Cache de nonces perdu au redémarrage (fenêtre ±90 s).
    - Automation, scènes, planning, palette : terminal par id allowlist uniquement.
    - Jamais de commande libre dans une règle, une scène, un job planifié
      ou un événement de calendrier.
    - Le calendrier n'a pas de terminal_id. L'heure d'un événement ne lance
      ni scène ni action.
    - Le shell interactif admin existant reste explicite (POST /api/shell sur une cible connue).
    - Les logs ne contiennent pas la commande brute.

  Navigateur
    - X-Content-Type-Options: nosniff, X-Frame-Options: DENY, Referrer-Policy,
      CSP (frame-ancestors none). Échappement HTML des textes non fiables.

  Tailscale / SSH
    - Ne pas élargir le pare-feu. OpenSSH : PasswordAuthentication no, clé publique.
    - Les hôtes viennent de la config ou du statut Tailscale, pas d'un champ client.

  Journal / push
    - Les métadonnées pin, token, commande, webhook sont retirées du journal.
    - hq_vapid.json et les abonnements push restent hors git.
