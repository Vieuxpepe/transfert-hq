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
