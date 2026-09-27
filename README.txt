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
  assets/hq.js       palette, bannière, aide contextuelle, journal, flotte, brief, voix, push
  assets/hq-calendar.js
  assets/hq-calendar.css
  assets/hq.css
  assets/hq-sw.js    service worker Web Push (opt-in)
  assets/qrcode.min.js

Les modules hq_* reçoivent des callbacks. Ils ne lancent pas de shell arbitraire
et n'importent pas le serveur HTTP (pas de cycle).

Accueil
-------
  État HQ (ok / attention / critique) → aujourd'hui → envoyer → appareils
  → activité récente (filtres Envois / Activité).
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
  À partir de 1100px, ces deux cartes sont côte à côte. En dessous,
  elles restent l'une sous l'autre.
  Ctrl+K ou « / » (hors champ) ouvre la palette. Elle ne lance qu'une cible
  allowlist (dossier, favori, scène, action, commande par id, fiche appareil).

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
  python -W error::SyntaxWarning -m py_compile iphone_bridge.py cc_ext.py hq_events.py hq_devices.py hq_automation.py hq_calendar.py hq_state.py

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
