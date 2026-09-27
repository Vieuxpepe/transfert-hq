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
  hq_automation.py   scènes / runbooks, règles, planning, backups, télémétrie, brief, push
  hq_devices.py      modèle d'appareils et capacités (dérivées, pas inventées)
  assets/hq.js       palette, bannière HQ, journal, flotte, brief, voix, push
  assets/hq.css
  assets/hq-sw.js    service worker Web Push (opt-in)
  assets/qrcode.min.js

Les modules hq_* reçoivent des callbacks. Ils ne lancent pas de shell arbitraire
et n'importent pas le serveur HTTP (pas de cycle).

Accueil
-------
  État HQ (ok / attention / critique) → points d'attention → scènes rapides
  → appareils → journal récent.
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

Règles
------
  Déclencheurs : manual, event (kind), device_online, disk_low.
  Actions : notify, scene, journal, backup, terminal (id), capture.
  cooldown_sec min 30. Master switch : automation_enabled.

Fichiers d'état (gitignorés — tolérer l'absence ; ne pas écraser un JSON cassé)
--------------------------------------------------------------------------------
  hq_events.json
  hq_automation.json
  hq_runs.json
  hq_telemetry.json
  hq_backup_index.json
  hq_push_subscriptions.json
  hq_vapid.json          clé privée Web Push — ne jamais committer
  bridge_config.json     PIN / webhook — ne jamais committer
  bridge_sessions.json
  + les fichiers v6 déjà gitignorés (queue, activity, kanban, scratchpad, …)

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

Web Push (dernier, opt-in)
--------------------------
  1. HTTPS obligatoire. Le HTTP :8765 nu ne suffit pas pour un iPhone.
     Préférer Tailscale Serve :
       tailscale serve --bg --https=443 http://127.0.0.1:8765
     Puis public_base_urls: ["https://TON-MACHINE.TAILNET.ts.net/"]
  2. push_enabled: true
  3. pip install cryptography   (génération VAPID si hq_vapid.json absent)
     pip install pywebpush      (envoi ; sans ce paquet, l'abonnement se stocke
                                 mais POST /api/push/test répond 409)
  Aucun service cloud n'est contacté tant que tu n'abonnes pas un navigateur.
  L'envoi va uniquement vers l'endpoint push du navigateur (VAPID).

Migration depuis v6
-------------------
  Même processus, même PIN, mêmes dossiers Inbox/Uni/Print.
  Les scènes v6 (explore / action) passent par le runner v7.
  La file « au réveil » (when=online) est inchangée.
  Aucune migration de base : les JSON hq_* sont créés au premier usage.
  Un JSON hq_* illisible est laissé tel quel (les lectures renvoient malformed).

Commandes
---------
  python -m unittest discover -s tests -v
  python -m py_compile iphone_bridge.py cc_ext.py hq_events.py hq_devices.py hq_automation.py


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
      écriture seulement sous la racine du pont, confirm=true obligatoire.

  Exécution distante
    - Pas de surcharge d'hôte SSH (champ host refusé). Cibles = shell_targets / pairs connus.
    - Automation, scènes, planning, palette : terminal par id allowlist uniquement.
    - Jamais de commande libre dans une règle, une scène ou un job planifié.
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
