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
  GET  /api/drawings            dessins de Inbox/Drawings (liste, 200 max)
  GET  /api/drawings/open?stem= document vectoriel validé (réouverture)
  GET  /api/drawings/file?stem=&kind=png|dxf|json
  POST /api/drawings            {name, source: mobile|desktop, doc, png} — corps ≤ 6 Mio
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
    La pause ne déplace ni ne supprime aucun backup existant (la rétention,
    plus bas, ne tourne qu'après un NOUVEAU backup réussi, donc jamais pendant
    une pause des backups automatiques, sauf après un backup manuel).
    Pas de contournement par un grand backup_every_hours : au démarrage, le
    planning ne reprend depuis le catalogue que s'il contient un backup de ce
    backup_dir (voir « Backup au démarrage ») ; sinon le premier backup
    planifié part au démarrage du pont.

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

  Rétention : "backup_keep_days" (défaut 14) et "backup_keep_min" (défaut 3)
    Après chaque NOUVEAU backup réussi (planifié, automatisation ou manuel),
    les backups de plus de backup_keep_days jours sont supprimés, en gardant
    TOUJOURS les backup_keep_min plus récents quel que soit leur âge (minimum
    1). Jamais de purge après un backup échoué ou sauté (intervalle, pause).
    backup_keep_days <= 0 désactive la purge. Valeurs invalides (texte, 7.5,
    true…) → défauts 14 / 3 ; normalisées au chargement de la config.
    La purge s'applique au backup_dir configuré, QUEL QU'IL SOIT — aujourd'hui
    C:\Backups\Transfert sur le contrôleur. Rappel : un backup sur le même
    disque que C:\Transfert ne protège PAS contre la perte de ce disque ; la
    rétention ne fait que limiter la place prise.
    Un dossier n'est supprimé que si TOUT est vrai :
      - il est DIRECTEMENT dans backup_dir (parent résolu = backup_dir résolu,
        même lecteur que celui configuré) ;
      - son nom est AAAAMMJJ_HHMMSS (^\d{8}_\d{6}$) ;
      - son âge vient de l'horodatage du nom, recoupé avec "at" de
        hq_backup_index.json quand l'entrée existe (écart > 1 jour : jamais
        supprimé) ; la date de modification n'est pas utilisée ;
      - il contient le marqueur README.txt « Transfert backup <id> » écrit par
        le pont (fichier normal, contenu exact) ;
      - ce n'est ni un lien symbolique, ni une jonction, ni un point d'analyse
        (os.lstat / FILE_ATTRIBUTE_REPARSE_POINT), et il n'en contient aucun :
        un dossier contenant un lien est laissé tel quel et signalé.
    backup_dir lui-même lien/jonction, résolu sur un autre lecteur, ou index
    illisible → aucune purge. La suppression ne suit jamais de lien ; un
    fichier en lecture seule dans le backup est rendu modifiable puis
    supprimé. Un échec sur un dossier est journalisé (« Purge impossible »)
    sans faire échouer le backup. Chaque suppression apparaît dans le journal
    d'activité et les événements (« Backup purgé … »), et son entrée est
    retirée de hq_backup_index.json. Rien d'autre (fichiers, dossiers au nom
    différent, autres lecteurs, D:) n'est touché.
    Santé : /api/health → backup.retention (keep_days, keep_min, enabled,
    last_purge_count, last_purge_at, last_purge_errors) ; la réponse de
    POST /api/backup contient le détail "purge".

  Backup au démarrage
    Au démarrage, le pont reprend le planning depuis le backup le plus récent
    de hq_backup_index.json dont le chemin est dans le backup_dir ACTUEL :
    un redémarrage moins de backup_every_hours après ce backup ne crée pas de
    nouveau backup ; le suivant part à l'échéance. Seul l'index est lu (pas
    backup_dir). Backup au démarrage comme avant si l'index est absent ou
    illisible, s'il n'a aucune entrée pour ce backup_dir (ex. après un
    changement de cible) ou si l'entrée est dans le futur. POST /api/backup
    reste forcé ; backup_auto_paused garde la priorité. Ligne de démarrage :
    « Backup : dernier backup … » ou « Backup : backup automatique au
    démarrage (<raison>) » ; /api/health → backup.startup_seed.

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
  python -W error::SyntaxWarning -m py_compile iphone_bridge.py cc_ext.py hq_events.py hq_devices.py hq_automation.py hq_calendar.py hq_state.py hq_companion.py hq_jobs.py hq_agent_ops.py hq_agent_protocol.py companion_agent.py companion_ops.py hqctl.py hq_planner.py hq_drawings.py hq_solid.py hq_face_solid.py hq_round_solid.py hq_earcut.py hq_carnet.py hq_carnet_rich.py hq_carnet_sources.py hq_carnet_media.py hq_carnet_eng.py hq_carnet_history.py hq_carnet_bulk.py hq_carnet_restore.py hq_carnet_links.py hq_carnet_report.py
  node tests/check_hq_features.mjs
  node tests/check_hq_sketch.mjs
  node tests/check_hq_solid.mjs
  node tests/check_hq_3d_nav.mjs
  node tests/check_hq_model.mjs
  node tests/check_hq_carnet.mjs
  node tests/check_hq_carnet_library.mjs
  node tests/check_hq_carnet_rich.mjs
  node tests/check_hq_carnet_sources.mjs
  node tests/check_hq_carnet_media.mjs
  node tests/check_hq_carnet_eng.mjs
  node tests/check_hq_carnet_history.mjs
  (optionnel, Playwright + racine jetable) python tests/visual_dessiner_playwright.py
  (optionnel, Playwright + racine jetable) python tests/visual_dessiner_3d_playwright.py
  (optionnel, Playwright + manifold3d ; serveur loopback jetable inclus) python tests/visual_face_playwright.py
  (optionnel, Playwright + WebKit, profil iPhone ; serveur loopback jetable inclus, saute si absent) python tests/visual_dessiner_webkit.py [--repeat 3]
  (optionnel, Playwright ; serveur loopback jetable inclus) python tests/visual_media_playwright.py
  (optionnel, Playwright Chromium + WebKit, profil iPhone ; serveur loopback jetable inclus) python tests/visual_model_playwright.py
  (optionnel, Playwright Chromium bureau + WebKit iPad/iPhone ; serveur loopback jetable inclus, saute si absent) python tests/visual_carnet_playwright.py [--part stage02|stage03]
  (optionnel, Playwright Node + Chromium ; serveur loopback jetable via tests/carnet_test_server.py, à lancer depuis une copie jetable) node tests/visual_carnet_rich_playwright.mjs
  (optionnel, Playwright Node + Chromium uniquement — WebKit/iOS NON VÉRIFIÉ ici ; même serveur jetable, copie jetable) node tests/visual_carnet_media_playwright.mjs
  (optionnel, Playwright Node + Chromium uniquement — WebKit/iOS NON VÉRIFIÉ ici ; même serveur jetable, copie jetable) node tests/visual_carnet_eng_playwright.mjs
  (optionnel, Playwright Node + Chromium uniquement — WebKit/iPhone/iPad physiques NON VÉRIFIÉS ici ; même serveur jetable, copie jetable) node tests/visual_carnet_history_playwright.mjs
  (optionnel, Playwright Node + Chromium uniquement — WebKit/appareils physiques NON VÉRIFIÉS ici ; même serveur jetable, copie jetable) node tests/visual_carnet_ux_playwright.mjs

Carnet — images (étape 06)
--------------------------
  Stockage   <ROOT>/.hq-carnet/assets/asset-<24 hex>.<jpg|png|webp> (noms générés, jamais de chemin client).
             Les pages ne contiennent que des métadonnées bornées (id, type MIME, dimensions, largeur 30-100 %,
             légende) : jamais d'octets, jamais de chemin. Pas de HEIC, pas d'image à position libre.
  Limites    12 Mo par fichier stocké (source choisie <= 16 Mo, <= 50 Mpx), grand côté <= 2560 px, 250 Mo au total,
             512 fichiers, 32 images par page, légende <= 300 caractères. Appliquées côté serveur.
  Traitement Le NAVIGATEUR redimensionne (<= 2560 px), applique l'orientation EXIF aux pixels et réencode
             (ce qui retire EXIF/GPS) AVANT l'envoi. Le SERVEUR (stdlib, aucun décodeur) ne transforme jamais les
             pixels : il valide la structure (signature, segments/chunks, CRC PNG, taille RIFF, EOI JPEG), lit les
             dimensions réelles, refuse EXIF orientation != 1, animés, tronqués, hors limites. Il ne détecte pas un
             flux de pixels corrompu dans un conteneur bien formé.
  API        POST /api/carnet/asset (corps brut, admin + CSRF, Content-Length obligatoire, en-tête facultatif
             X-Carnet-Mime comparé au contenu réel) ; GET /api/carnet/asset/<id> ; GET /api/carnet/asset (usage).
  Cycle      Un envoi est durable dès qu'il est finalisé. Retirer/remplacer une image ne supprime RIEN : les orphelins
             comptent dans le quota (message explicite quand il est atteint). Aucun nettoyage automatique ni manuel
             à l'étape 06 (un brouillon hors ligne peut encore référencer un fichier que le serveur ne voit pas) :
             reporté à une étape avec sémantique d'atteignabilité brouillons/historique.
  Sauvegarde Les images RÉFÉRENCÉES par le carnet copié sont ajoutées sous Carnet/assets/ ; un fichier manquant ou
             des métadonnées invalides rendent la copie « valid: false » (la purge des anciens backups est alors
             suspendue). Export Markdown avec images : <nom>.md + <nom>.assets/ (liens relatifs).

Carnet — outils d'ingénierie (étape 07)
---------------------------------------
  Accès      Un seul bouton « Ingénierie » dans le plateau « Symboles et outils » (replié par défaut) : rien de
             nouveau sur la page tant qu'on n'y touche pas. Le bouton « Heure » existant insère « HH:MM — ».
  Blocs      calc (calcul) et measure (mesure) sont des blocs atomiques sans texte ; decision est une ligne de texte
             avec un statut daté. Charges utiles strictes (clés inconnues refusées, décimaux canoniques <= 15
             chiffres, unités d'une liste fermée) ; <= 50 calculs/mesures et <= 100 décisions par page.
  Calcul     Arithmétique seulement : nombres, + - * / ^, parenthèses, signes unaires ; « , » = séparateur décimal ;
             pas de fonctions, pas de multiplication implicite. Jamais évalué côté serveur ni par eval/Function.
             Résultat 12 chiffres significatifs ; |x| entre 1e-100 et 1e100 ; erreurs visibles (division par zéro,
             hors plage, syntaxe). Virgule flottante binaire : après une forte annulation, les derniers chiffres
             peuvent porter du bruit.
  Conversion mm/in, N/lbf, N·m/lb·ft, bar/psi, °C/°F, kg/lb (constantes exactes) ; le résultat est ajouté APRÈS le
             texte d'origine, jamais à sa place.
  Mesure     Tolérance : ± symétrique, bornes absolues, ± % du nominal, ou aucune. Verdict DÉRIVÉ (jamais stocké),
             arithmétique décimale exacte, bornes incluses ; unités différentes = « incompatible » (aucune
             conversion silencieuse). Toujours étiqueté « aide de carnet, non certifié ».
  Tâches     « Tâche » crée UNE carte dans « À faire » du tableau existant (action carnet task_extract) ; le texte de
             la note n'est jamais modifié et aucun lien retour n'est enregistré (le tableau n'a pas ce champ).
             Liées à la page, au bloc, à la plage UTF-16 et au texte exact ; request_id contre le double envoi.
  Liens HQ   note, projet, fichier, Lecteur (média/3D), dessin : la cible est vérifiée à l'ouverture ; un dessin
             ouvre seulement l'onglet Dessiner (pas d'ouverture du dessin exact). Annotation : reportée.

Lecteur 3D (.stl, .glb)
-----------------------
  Les fichiers .stl (binaire ou ASCII) et .glb d'Inbox, Uni et Print apparaissent dans
  le Lecteur ; double-clic / double-tap dans Fichiers les ouvre. Un doigt tourne, deux
  doigts déplacent et zooment (souris : clic droit ou Maj pour déplacer, molette pour
  zoomer) ; « Recadrer » remet la pièce au centre. Tout est lu dans le navigateur
  (assets/hq-model-view.js, sans réseau externe) ; /media/ envoie ces fichiers en pièce
  jointe avec une CSP sandbox, jamais affichés tels quels.
  GLB : maillages, indices, transformations des nœuds, couleur de base des matériaux.
  Non pris en charge : textures, Draco / meshopt (message clair si requis), animations,
  squelettes, .gltf à fichiers séparés. Limites : 64 Mo, 300 000 triangles
  (30 000 sans WebGL).

Dessiner (croquis mécanique)
----------------------------
  Onglet Dessiner : tactile, stylet, souris. Deux modes sur le MÊME dessin :
    Croquis rapide : stylo main levée, gomme (objet), notes texte déplaçables,
                     cotes manuelles linéaires / angulaires (annotations seulement).
    Construction   : lignes, rectangles, cercles, axes ; accroche grille et angle
                     (pas réglable) ; longueur pilotante (une extrémité fixe, l'autre
                     glisse) ; angle pilotant entre deux lignes reliées (la ligne
                     choisie pivote autour du sommet commun, longueur conservée).
  Une modification qui déformerait de la géométrie reliée que le solveur ne sait pas
  résoudre (ex. pivoter un côté d'un contour fermé) est refusée avec un message ;
  le dessin n'est pas modifié. Les contraintes pilotantes déjà posées sont vérifiées
  après chaque édition (déplacement, poignée, cote).
  Repère Y vers le haut (flèches X/Y en bas à gauche), unités explicites (mm, cm, m,
  po), pas de grille en unités réelles. Annuler/Rétablir, sélection (Maj ou « Multi »),
  déplacement, suppression, pincer pour zoomer, deux doigts / Main pour se déplacer.
  Dès qu'un stylet est vu, un doigt seul déplace la vue (rejet de paume).
  Brouillon local (localStorage) sauvegardé en continu et au changement d'appli.

  Pièce 3D : en Construction, sélectionner un rectangle, un cercle ou des lignes
  formant un seul contour fermé ; saisir une profondeur positive et Extruder.
  Sélectionner ensuite un autre contour strictement intérieur pour Enlever matière,
  en coupe borgne (profondeur depuis la face supérieure) ou traversante. Les
  contours ouverts, croisés, ramifiés, qui se touchent ou se chevauchent sont
  refusés sans changer la pièce. Une seule extrusion de base ; les coupes ne se
  recouvrent pas. Les traits libres, axes, textes et cotes sont exclus des solides.
  Aperçu 3D : tourner au doigt/souris, pincer ou utiliser la molette pour zoomer,
  recentrer. Le serveur recalcule le même maillage pour l'aperçu et le STL ;
  il ne sauvegarde rien lors d'un simple aperçu. Les fonctions 3D sont annulables
  et éditables par retrait puis recréation. Le DXF demeure une esquisse 2D ; le
  STL est un maillage, non un historique de fonctions SolidWorks.
  Croquis sur face : dans l'aperçu 3D, toucher une face plane, puis « Dessiner sur
  cette face ». Rectangle, cercle et contour fermé sont disponibles au doigt,
  stylet ou souris ; saisir la profondeur puis ajouter ou enlever la matière.
  Fonctionne sur les faces supérieures, inférieures et latérales planes, y compris
  celles créées par une extrusion précédente. Le profil doit rester sur la face ;
  les opérations qui créent une pièce vide, séparée ou non fermée sont refusées.
  Les croquis de face sont stockés dans le JSON v3 et peuvent être retirés puis
  recréés ; les outils de cotes pilotantes du croquis 2D ne s'y appliquent pas.
  Arrondis : dans l'aperçu 3D, choisir « Arrondir une arête », toucher une arête
  droite convexe, saisir un rayon et appliquer. Le serveur enlève réellement la
  matière du coin ; aperçu et STL montrent le même arrondi. Arêtes courbes ou
  rentrantes, rayons traversant une autre partie de la pièce et combinaisons
  incompatibles sont refusés avec un message sans modifier le dessin. Retirer
  un arrondi depuis la liste des fonctions pour le refaire à un autre rayon.
  Pour ces fonctions, installer avant le démarrage du bridge, avec son Python :
    python -m pip install -r requirements-face3d.txt
  Paquets épinglés : manifold3d 3.5.4 et numpy 2.5.3. Sans eux, les dessins v1/v2
  continuent de fonctionner et les fonctions sur face/arrondis renvoient une erreur claire.

  Enregistrement dans ROOT/Inbox/Drawings (même résolution qu'Inbox/Voice) :
    <nom>_HQWeb-Mobile|_HQWeb-Desktop[.hqdraw.json|.png|.dxf|.stl], même radical.
    Le .stl n'est créé que si le dessin contient une pièce 3D valide. Le STL
    binaire n'a pas de champ d'unités : ses coordonnées sont toujours en mm.
    Le suffixe est une estimation (pointeur grossier / écran tactile / taille de
    fenêtre), jamais le nom exact de l'appareil. Le nom est nettoyé côté serveur ;
    aucun chemin client n'est accepté. Collision : -2, -3… (jamais d'écrasement).
    Écriture : fichier temporaire caché (O_EXCL, fsync) puis os.link sans écrasement.
    Inbox/Drawings lien symbolique / jonction / point d'analyse : refusé.
    Fichiers liés (symlink, reparse) : ignorés à la liste, refusés à l'ouverture.
  DXF ASCII (AC1009 + $INSUNITS), coordonnées réelles 1:1, Y vers le haut :
    GEOMETRIE (LINE, CIRCLE), AXES (LINE, type CENTER),
    REFERENCE_MAIN_LEVEE (POLYLINE simplifiée), NOTES (TEXT),
    COTATIONS (LINE/ARC/TEXT). Aucune entité DIMENSION : les cotes manuelles
    ne deviennent jamais des contraintes CAO. Les cotes pilotantes restent dans
    le .hqdraw.json ; le DXF porte la géométrie résultante.
  Format .hqdraw.json v2/v3 : format, version, units, grid, snap, points[{id,x,y}],
  objects[{id,type,...}] (les lignes référencent des id de points : connectivité
  explicite), constraints[{id,type:length|angle,...}],
  features[{id,type:extrude|cut,profile:[object-id,...],depth,extent}], meta.
  V3 ajoute faceFeatures[{id,type,plane:{origin,u,v,normal},profile:[[u,v],...],
  depth,extent}] et roundFeatures[{id,a:[x,y,z],b:[x,y,z],radius}] ; les fichiers
  v1/v2 restent lisibles.
  Les anciens fichiers v1 restent lisibles et passent en v2 à la première
  fonction 3D. Triangulation embarquée sous licence ISC (EARCUT-LICENSE.txt).
  Contrôle manuel : non fait sur un vrai iPhone Safari, ni import SolidWorks, ni
  jonction Windows réelle (test unitaire Windows seulement, ignoré ailleurs).

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

Carnet — historique, opérations groupées, rapport (étape 08)
-----------------------------------------------------------
  Accès      Rien sur la page par défaut. « Historique » (plateau « Symboles et outils », replié) et « Opérations… »
             (en-tête de la bibliothèque) ouvrent UNE boîte de dialogue modale créée à la demande : Historique,
             Opérations groupées, Rapport, « Liée depuis… ». Aucune donnée n'est gardée dans le navigateur.
  Historique Fichier séparé <ROOT>/.hq-carnet/history.json (sa propre révision ; ne touche jamais notebook.json /
             sources.json hors opération). AUCUN instantané automatique : seuls un point de restauration demandé, une
             restauration, une opération groupée, son annulation et la corbeille/restauration/suppression d'une page
             (métadonnées seules) y figurent ; la frappe et l'enregistrement automatique n'y laissent rien.
             Bornes : 200 événements, 20 points par page, 4 Mo au total, 1 Mo par événement, 256 Ko par instantané,
             fenêtre d'annulation = 10 dernières opérations, 64 cibles par opération. L'élagage retire les plus
             anciens non protégés (les 10 dernières opérations annulables sont protégées) et compte pruned_total ;
             si un événement ne tient pas, l'OPÉRATION est refusée. Octets illisibles : conservés tels quels, jamais
             réparés ; les opérations d'historique sont refusées (503 history_unavailable), la note reste modifiable.
             Verrous : carnet (extérieur) puis historique (intérieur) ; l'événement « pending » est écrit AVANT la
             donnée puis finalisé : un arrêt brutal laisse un événement visible, jamais un état « avant » perdu.
  Restaurer  Confirmation explicite + expected_rev : crée une NOUVELLE révision (jamais de retour en arrière), ne supprime
             rien de l'historique, et son avant-état permet de revenir. Révision périmée = 409, rien n'est modifié.
  Groupées   Portée → nombre affecté → aperçu (même code sur une copie) → confirmation (confirm + expected_count) →
             application sensible aux révisions → Annuler → UN événement logique. Application PARTIELLE : chaque cible
             est appliquée / ignorée / en conflit / en échec ; jamais de « succès » global trompeur ; l'événement
             n'enregistre que ce qui a réellement été appliqué. Opérations : remplacer du texte (les occurrences qui
             touchent une mise en forme, un lien ou une référence sont ignorées), déplacer vers un projet/catégorie,
             corbeille/restauration (la dernière page active n'est jamais mise à la corbeille), migration de sources,
             remplacement du fichier lié. Une page avec brouillon local non enregistré n'est jamais touchée.
  Plan       L'aperçu renvoie un jeton opaque « plan-… » (900 s, 64 max, en mémoire du processus) lié à
             {opération, paramètres normalisés, ids+révisions exacts des cibles « will_apply », nombre}. L'application
             l'EXIGE : absent = 400 ; inconnu/expiré/déjà utilisé = 409 plan_expired ; paramètres, opération, cible
             ou révision différents = 409 plan_mismatch (rien n'est écrit, le plan reste valable). La confirmation doit
             rendre compte EXACTEMENT de l'ensemble prévisualisé : cibles envoyées ∪ client_skipped = cibles du plan (ni
             oubli, ni ajout, ni doublon) et expected_count = nombre prévisualisé − nombre de client_skipped. Le plan est
             RÉSERVÉ atomiquement (prêt → en cours) au moment de la validation : une 2e requête avec le même jeton reçoit
             409 plan_in_use ; consommé après succès ; libéré si l'application échoue sans rien écrire (nouvelle tentative).
             Un seul aperçu = au plus UNE opération groupée / UN événement. Un redémarrage du serveur invalide les plans : refaire l'aperçu.
  Verrous    Ordre documenté : carnet → sources → historique. La migration de sources garde le verrou sources de la
             validation de la révision de l'édition cible jusqu'à l'écriture du carnet ; une édition concurrente
             attend, puis une révision périmée échoue sans rien changer. Le module sources ne prend jamais le
             verrou du carnet (pas d'interblocage).
  Migration  Sémantique « nouvelle édition — à vérifier » (étape 05) : src = nouvelle édition, emplacement VIDE (type
             conservé), pdf null, ok false ; l'ancien emplacement/page PDF ne sont conservés que dans « from »
             (provenance) et affichés dans l'aperçu ; aucun calibrage n'est appliqué.
  Fichier lié Seul sources.json change. Si un calibrage existe : avertissement en tête de l'aperçu + confirmation
             explicite ; le succès EFFACE le calibrage (aucun recalibrage automatique) ; Annuler rend l'ancien
             fichier ET l'ancien calibrage ; une révision de source périmée échoue sans rien changer.
  Annuler    Seulement parmi les 10 dernières opérations, une fois, sans « rétablir » ; chaque cible n'est annulée que si
             sa révision est encore celle écrite par l'opération (le travail plus récent n'est jamais écrasé) ;
             annulation partielle explicite. Annuler une restauration de corbeille remet à la corbeille (date neuve).
  Liée depuis… Dérivé des références structurées existantes (liens note/projet/fichier/média/dessin, références de
             sources, lien de mesure) : jamais de texte libre. Rien n'est stocké ; consulter n'écrit rien. Mémo
             paresseux par (page, rev, updated_at), borné (1024) ; target_exists est résolu pour chaque type
             (true/false, null = illisible, jamais de chemin) et target_archived pour les sources ; pages à la corbeille listées à part ; aucune
             opération par frappe. GET /api/carnet?backlinks=<type>&id=<id>.
  Rapport    Liste ORDONNÉE par l'utilisateur (notes, mesures, décisions, photos, sources) ; chaque page est liée à sa
             révision (409 report_stale si elle a changé : rien n'est généré). Aucun texte rédigé : seulement le
             contenu existant + libellés structurels fixes + annexe « Sources citées ». Affiché en ligne, exportable en
             .md + <nom>.assets/ (liens relatifs, jamais d'écrasement, même écrivain confiné que l'export de page) ou
             imprimé. Lecture seule vis-à-vis du carnet ; aucun chemin absolu.
  QR         REPORTÉ (décision D3) : aucun routage par hash, aucune navigation propre au QR.
  Sauvegarde history.json est copié avec notebook.json/sources.json sous Carnet/ (octets illisibles copiés tels quels,
             copie « valid: false » qui suspend la purge) ; l'index « Liée depuis… » se reconstruit depuis le carnet.
             Fermeture média : les images référencées par le carnet COURANT et par les points de restauration conservés
             (checkpoint.content, restore.pre_content) sont copiées une seule fois sous Carnet/assets ; une image
             historique manquante rend la sauvegarde « valid: false » (octets conservés) ; historique illisible = invalide.
  Tests      python -m unittest tests.test_hq_carnet_history tests.test_hq_carnet_links_report ; node
             tests/check_hq_carnet_history.mjs ; node tests/visual_carnet_history_playwright.mjs (Chromium ; WebKit et
             appareils physiques iPhone/iPad NON VÉRIFIÉS ici).

Carnet — passe UX + manipulation directe des images (post-acceptation, hors étapes 01-08)
------------------------------------------------------------------------------------------
  Schéma     asset.layout vaut "inline" | "center" | "right" (alignement borné dans le flux ; "inline" = comportement
             accepté de l'étape 06, désormais rendu aligné à gauche). Aucune clé nouvelle (id, mime, w, h, width,
             layout, caption), aucune position x/y, aucun CSS persisté. width reste le contrôle de taille (30-100, pas de 5).
             Python et JS valident à l'identique (booléen/NaN/Infinity/hors plage refusés). Un ancien contenu n'est jamais
             réécrit par une simple consultation : la migration passe uniquement par une sauvegarde/édition normale.
             Encodage canonique JS (brouillons/bases) : la ligne image garde 6 éléments pour "inline" (octets inchangés),
             un 7e élément "center"/"right" n'existe que pour les alignements non par défaut.
  Interface  « + Insérer » visible au-dessus de l'éditeur (Image, Appareil photo, Fichier et Dessin = liens HQ, Mesure,
             Calcul, Décision) ; les outils avancés restent derrière « … » (Plus d'outils). L'en-tête de la bibliothèque
             est structurel (titre + fermer sur une ligne, actions sur la suivante) ; Corbeille est séparée des filtres.
  Images     Insertion : menu, panneau existant, glisser-déposer d'un fichier image (surbrillance), collage depuis le
             presse-papiers : TOUS passent par le pipeline accepté de l'étape 06 (préparation navigateur -> POST
             /api/carnet/asset admin + CSRF). Image sélectionnée : poignée de déplacement (réordonne les blocs
             uniquement), poignées de taille (pas de 5 %, ratio conservé), barre contextuelle : Monter, Descendre,
             Plus petite, Plus grande, Gauche/Centre/Droite, Légende, Remplacer, Retirer. Un geste = une seule édition
             locale (brouillon + sauvegarde différée 450 ms) = au plus une révision serveur ; aucune sauvegarde pendant
             le déplacement du pointeur ; un geste obsolète (page, révision, génération de l'éditeur) est abandonné.
  Export     Markdown/TXT/rapport : image + légende, texte identique pour inline/center/right (pas d'alignement en
             Markdown). Impression : alignement et largeur conservés dans la zone imprimable.
  Tests      python -m unittest tests.test_hq_carnet_media ; node tests/check_hq_carnet_media.mjs ;
             node tests/check_hq_carnet_image_ui.mjs ; node tests/visual_carnet_ux_playwright.mjs (Chromium ; WebKit et
             appareils physiques NON VÉRIFIÉS ici).


Carnet — passe d'édition (phase 2 de la passe UX, post-acceptation, hors étapes 01-08)
---------------------------------------------------------------------------------------
  Schéma     AUCUN changement (Python et JS inchangés dans cette phase). Rien de ce qui suit n'est stocké, exporté ni
             envoyé au serveur : titre visuel, barres flottantes, menus, rail de bloc, badge de taille sont de la
             présentation éphémère. Une seule action = une seule édition locale normale (brouillon + sauvegarde 450 ms).
  Titre      Le premier bloc texte (texte/titre/puce/numéro/case) reçoit un attribut visuel non persisté ; derive_title()
             (première ligne non vide) reste seul juge. Jamais appliqué à une image / un calcul / une mesure / une
             décision, même en première position. Page vide : aide « Tape / pour les commandes » (tactile : « + Insérer »).
  Sélection  Barre flottante près de la sélection (au-dessus au pointeur, en dessous au tactile, toujours dans l'écran) :
             Gras, Italique, Souligné, Surligné, Code, Lien, Référence, Effacer la mise en forme. Alt+F10 la focalise,
             flèches/Début/Fin, Échap la ferme et rend focus + sélection. La sélection est revalidée à l'application
             (page + génération + offsets) ; une sélection périmée ne fait rien (message visible, pas de nouvel essai).
  Commandes  Registre unique (assets/hq-carnet-commands.js) pour « + Insérer », le menu « / », le « + » entre blocs et le
             menu de bloc ; toutes les commandes finissent dans runInsert. « / » en début de ligne vide ou après un
             espace (jamais pendant une composition IME, jamais mi-mot) est annulé et ouvre le menu (recherche propre,
             haut/bas/Entrée/Échap, aria-expanded/aria-selected). Choisir une commande consomme la barre oblique.
             Fermeture ordinaire (Échap, clic ailleurs, Tab) : UNE barre oblique littérale est remise à l'endroit d'origine
             si page/bloc/texte/génération sont inchangés ; sinon rien n'est modifié (jamais dans un autre bloc).
  Blocs      Rail flottant unique (glisser, +, ⋯) dans la marge gauche au survol (tactile : bloc du curseur, boutons 44 px) ;
             « + » entre deux blocs près d'une jointure ; menu ⋯ : Monter, Descendre, Dupliquer (nouvel id ; plafonds
             32 images / décisions respectés), Insérer au-dessus/en dessous, Convertir (texte/titre/puce/numéro/case
             seulement, jamais un atome), Supprimer (confirmation si le bloc n'est pas vide). Clavier : Alt+Maj+↑/↓
             déplace le bloc du curseur, Alt+Maj+B ouvre le menu. Le glisser réutilise le code de geste des images :
             ids conservés, une édition, aucune écriture pendant le déplacement, geste obsolète abandonné.
  Images     Barre contextuelle flottante ancrée à l'image (feuille du bas au tactile/étroit), badge « 70 % · centré »,
             état sélectionné renforcé, légende/Remplacer/Retirer visibles.
  Bibliothèque  Compteurs dérivés à côté des filtres ; Projets/Catégories repliables (état EN MÉMOIRE de la page seulement :
             ni brouillons hq_carnet_drafts_v1, ni stockage navigateur) ; la section repliée garde la puce du filtre actif ;
             page courante marquée ; états vides explicites.
  Thèmes     Sombre par défaut, clair via prefers-color-scheme (pas de bascule) ; texte sur accent à contraste ≥ 4.5.
  Reporté    Boutons Annuler/Rétablir visibles dans l'éditeur (l'annulation native de frappe et les raccourcis restent ;
             l'annulation groupée de l'étape 08 est inchangée), groupes d'images/côte à côte, rotation/recadrage, tri de
             la bibliothèque, redimensionnement de la barre latérale, lien vers un bloc, cartes de pièces jointes.
  Tests      node tests/check_hq_carnet_commands.mjs ; node tests/check_hq_carnet_editor_ui.mjs ;
             node tests/visual_carnet_editor_playwright.mjs (Chromium, schémas de couleur émulés, IME via CDP ; WebKit,
             Firefox et appareils physiques NON VÉRIFIÉS ici).

Carnet — ergonomie + animations (phase 16C)
--------------------------------------------
  Module     assets/hq-carnet-motion.js (présentation seulement : n'écrit aucune note, aucun stockage navigateur, aucun réseau).
  Téléphone  (≤ 720 px) Précédent / Suivant vont dans la barre Capture terrain, Copier · n/N · Nouvelle page dans une pastille
             juste au-dessus (mêmes boutons déplacés : ids et raccourcis inchangés) ; la barre de page cachée sous la barre
             Capture disparaît (DF-1). En mode concentration, tout revient dans la barre de page.
  Capture    Le bouton Capture se range pendant la frappe ou le défilement dans le Carnet et revient après ~1,4 s d'inaction
             (DF-3) ; le focus clavier le fait toujours réapparaître.
  Accent     Indigo dans le Carnet seulement (l'en-tête, la navigation et le bouton Capture gardent l'accent de l'app) ;
             focus = anneau neutre 3 px, sélection = teinte, enfoncé = teinte + ombre intérieure, réussite = --ok (vert).
  Clavier    La ligne en cours reste au-dessus du clavier et de la barre ; menus et barre de sélection limités à la zone visible.
  Gestes     La page suit le doigt (élastique s'il n'y a pas de page dans ce sens ; tourne à 30 % de la largeur ou d'une
             pichenette) ; tirer vers le bas en haut de page : Plan de la page, plus loin : Bibliothèque ; appui long dans
             la marge ou sur une image / carte / croquis : menu du bloc (dans le texte, l'appui long reste celui du système).
  Annuler    Après Supprimer / Déplacer / Dupliquer un bloc : bandeau « Annuler » (6,5 s, pause au survol/focus, glisser pour
             fermer). L'annulation ne s'applique que si la page est exactement celle produite par l'opération ; sinon rien
             n'est modifié et un message le dit.
  Animations Menus qui naissent du point touché, blocs qui glissent (insertion / suppression / déplacement), bloc soulevé
             pendant le glisser, case cochée qui rebondit + « Liste terminée », pastille d'enregistrement en coche, carte de
             bibliothèque qui s'agrandit en page, croquis qui grandit vers l'inspecteur, images en chargement, squelette au
             démarrage. Réduction des animations : fondus seulement, aucun déplacement.
  PC         Pavé tactile : glisser à deux doigts vers la gauche / droite tourne la page (suit le geste ; molette verticale
             et Maj+molette ne tournent jamais). Boutons et Alt+flèches : la page arrive en glissant. Clic droit dans la marge
             ou sur une image / carte / croquis : menu du bloc (dans le texte, le menu du navigateur reste). Remonter la
             molette déjà en haut de page : Plan de la page, plus loin : Bibliothèque.
  Tests      node tests/check_hq_carnet_motion.mjs ; python tests/visual_carnet_16c_playwright.py [--shots <dossier>]
             (Chromium téléphone + bureau ; WebKit et appareils physiques NON VÉRIFIÉS ici).

Carnet — notes autocollantes (phase 16D)
-----------------------------------------
  Usage      Bouton « note » dans la barre du haut ou Alt+Maj+N : une note s'ajoute en haut à droite de la partie visible
             de la page. Glisser la barre colorée (ou la poignée ⠿, flèches au clavier, Maj = plus vite) pour la déplacer ;
             ● change la couleur (jaune, rose, bleu, vert, violet) ; – replie (seule la première ligne reste) ; copier met
             le texte dans le presse-papiers ; × ferme (bandeau « Annuler » pour la rétablir).
  Stockage   <ROOT>/.hq-carnet/stickies.json (propre fichier, propre verrou, propre révision) via GET/POST
             /api/carnet/stickies (admin + CSRF). Jamais dans notebook.json, l'historique, les instantanés, la recherche ou
             les rapports : ce n'est pas du contenu de page. Copié dans la sauvegarde du Carnet (Carnet/stickies.json).
  Position   x = fraction de la largeur de page (la note garde sa place du téléphone au PC, toujours entièrement visible),
             y = pixels depuis le haut de la page. 40 notes par page, 1000 au total, 4000 caractères par note.
  Appareils  Toutes les notes sont partagées (actualisées toutes les 15 s quand le Carnet est visible). Une modification
             basée sur une version périmée est refusée (409) : la version la plus récente s'affiche, rien n'est écrasé.
  Tests      python -m unittest tests.test_hq_carnet_stickies ; node tests/check_hq_carnet_stickies.mjs ;
             python tests/visual_carnet_16c_playwright.py (bureau + téléphone, Chromium).

Carnet — finitions (phase 16E)
------------------------------
  Toucher    Onde qui part du point touché dans chaque bouton du Carnet ; petit retour haptique (iPhone : bascule cachée,
             Android : vibration) en cochant, en déposant un bloc ou une note, en ajoutant / copiant une note, en ouvrant un
             menu au doigt.
  Animations Ombre de pli sur le bord qui se soulève pendant qu'on tourne la page ; numéro de page qui roule ; éléments
             des menus en cascade ; cartes de la bibliothèque qui arrivent l'une après l'autre ; bloc ajouté qui s'illumine ;
             bloc déposé qui se pose depuis l'endroit où on l'a lâché ; confettis quand une liste est terminée ; images qui
             apparaissent en fondu ; page qui « respire » en entrant / sortant du mode concentration.
  Notes      La note se pose avec un petit rebond, penche quand on la prend, oscille en se posant ; couleur en fondu ;
             le texte s'enroule en repliant ; bulle « Copié ». Au survol (souris) : cartes, boutons et notes se soulèvent.
  Réduction  Avec « réduire les animations » : aucune onde, aucun mouvement, aucun confetti ; seuls des fondus restent.

Carnet — taille de la page, du texte et de la bibliothèque (phase 16G)
-----------------------------------------------------------------------
  Page       PC (≥ 900 px, souris) : poignée sur le bord droit de la page ; glisser élargit / rétrécit (aimants Étroite
             640, Normale 820, Large 1080, Pleine largeur), double-clic ou Entrée : largeur par défaut, Échap pendant le
             glisser : annule. Flèches sur la poignée (Maj = plus vite), Début / Fin. Aussi dans « ⋯ » → Affichage.
  Texte      A− / A+ / Défaut dans « ⋯ » → Affichage (tous les appareils), Ctrl+< et Ctrl+> au clavier. Taille et
             interligne changent ensemble en pixels entiers : le texte reste sur les lignes du papier.
  Bibliothèque PC, bibliothèque ancrée : glisser la ligne entre la bibliothèque et la page (220–440 px) ; double-clic :
             par défaut.
  Mémoire    Réglages de CET appareil (localStorage « hq_carnet_sizing_v1 », au mieux : refusé = valable jusqu'au
             rechargement). Rien n'est envoyé à HQ, aucune note n'est modifiée.
  Tests      node tests/check_hq_carnet_sizing.mjs ; python tests/visual_carnet_16c_playwright.py.

Carnet — papier et barre du haut (phase 16H)
---------------------------------------------
  Papier     « ⋯ » → Affichage → Papier : Lignes (défaut), Quadrillé, Points, Uni, Plan (bleu, grille fine + grille
             majeure toutes les 5 lignes). Teinte : Auto (suit le thème), Crème, Blanc, Sépia, Ardoise, Noir (OLED).
             L'accent sur le papier suit sa clarté (puces et liens lisibles). Réglage de CET appareil (même mémoire que
             les tailles).
  Barre      « + Insérer » est dans la barre du haut (une ligne sur PC, deux sur téléphone). Sur PC, barres et
             bibliothèque s'estompent pendant la frappe et reviennent dès que la souris bouge, qu'on remonte ou qu'on
             quitte l'éditeur ; survol ou Tab les affichent aussitôt ; un avertissement d'enregistrement reste visible.

Carnet — finitions de mouvement (phase 16I, assets/hq-carnet-feel.js)
---------------------------------------------------------------------
  Sorties    Menus, plan, outils « ⋯ », barre de format, inspecteur et feuilles repartent comme ils sont venus (une
             copie inerte joue la sortie ; l'élément réel est déjà fermé, rien n'attend l'animation).
  Feuilles   Téléphone : bibliothèque et plan montent du bas, suivent le doigt vers le bas et se ferment au-delà
             d'un quart de hauteur ou d'un geste rapide ; sinon elles reviennent en place (poignée en haut).
  Courbes    Une seule famille de courbes et durées pour HQ (--hq-spring, --hq-out, --hq-in, --hq-dur*), partagée
             par le Calendrier, l'Accueil et le Carnet.
  Curseur    PC : le curseur de saisie glisse entre les positions et ne clignote qu'à l'arrêt (natif en IME,
             au tactile et en mouvement réduit).
  Encre      « Surligné » se pose comme un marqueur (de gauche à droite) ; cocher une tâche trace un trait dessus.
  Pages      Une nouvelle page tombe de la pile ; une page mise à la corbeille se froisse et file vers la Corbeille.
  Biblio.    Les fiches glissent vers leur nouvelle place quand la liste change ; l'épingle tombe avec un rebond.
  Plan       Un repère suit la section en cours de lecture.
  Notes      Glisser une note l'aligne (8 px) sur les bords et centres de la page et des autres notes, avec un
             guide pointillé ; fermer la froisse.
  Mesures    Les valeurs et résultats comptent jusqu'à leur valeur (sur un calque, le texte n'est jamais modifié) ;
             le verdict de tolérance apparaît d'un « pop ».
  Lumière    PC : l'ombre et un léger reflet du papier suivent la souris.
  Images     Une image insérée s'ouvre depuis un anneau.
  Tout est présentation seulement et coupé en mouvement réduit. Tests : tests/check_hq_carnet_feel.mjs,
  tests/visual_carnet_16c_playwright.py (section 16I).
