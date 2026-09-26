Transfert HQ v6
===============

NEW (except Web Push & voice notes)
  Chunked / resumable uploads + Mo/s meter
  Offline queue (IndexedDB) — flushes when back online
  Scheduled backup (backup_every_hours → backup_dir)
  Who's-home history chart (LAN / Tailscale / relay)
  Allowlisted terminal commands
  App launcher grid
  Printer picker + preview
  Multi-user PINs: users[{name,pin,role:admin|upload}]
  Shared kanban (kanban.json)
  Wallboard themes: ?theme=oled|midnight&kiosk=1
  Full-text search (.txt/.md/…)
  Inbox zero: archive / sort / empty-tmp

  Captures d'écran → Inbox/Captures (auto)
    HQ button, Win+PrintScreen folders, uploads named Screenshot/Capture*,
    and remote Windows PCs (OpenSSH) are harvested every ~45s.
    Toggle: screenshot_ingest_enabled / screenshot_ingest_every_sec

URLS
  http://192.168.2.152:8765/
  http://192.168.2.152:8765/wallboard?theme=oled&kiosk=1

Optional shell
  "ssh_user": "YourWindowsUser"
  "shell_targets": [
    {"id": "local", "label": "Ce PC", "type": "local"},
    {"id": "laptop", "label": "Laptop", "type": "ssh", "host": "100.x.y.z", "user": "you"}
  ]
  Tailscale peers are auto-listed when online.

Remote disk bars (other Windows PCs)
  1. Copy Enable-OpenSSH-Server.bat to the other PC → Run as admin
  2. Copy Authorize-HQ-SSH-Key.bat + hq_ssh.pub to that PC → Run as admin
  3. Keep Tailscale connected; HQ "ssh_user" = that PC's Windows username
  Note: Tailscale SSH UI does not exist on Windows — this uses OpenSSH over 100.x.


HTTPS (recommandé) — Tailscale Serve
------------------------------------
Le pont écoute en HTTP clair sur :8765. Ne pas exposer :8765 brut sur Tailscale
sans TLS. Préférer Tailscale Serve (termine le TLS, reverse-proxy vers localhost) :

  tailscale serve --bg --https=443 http://127.0.0.1:8765

Funnel (public Internet) seulement si tu assumes le risque :

  tailscale funnel --bg --https=443 http://127.0.0.1:8765

Ensuite, ajoute l'URL HTTPS Serve dans bridge_config.json (ne jamais committer
ce fichier — il contient le PIN) :

  "public_base_urls": ["https://TON-MACHINE.TAILNET.ts.net/"]

Ces URLs alimentent l'allowlist CSRF et les QR (URL uniquement, jamais de PIN).
Derrière Serve, le cookie de session reçoit le flag Secure (via X-Forwarded-Proto).

Config utile (schéma, sans secrets)
-----------------------------------
  pin / users[]     — auth
  public_base_urls  — bases HTTPS/LAN extras pour CSRF + QR
  bind_host         — défaut 0.0.0.0 si PIN actif
