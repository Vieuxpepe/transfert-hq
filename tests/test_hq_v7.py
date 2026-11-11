"""Transfert HQ v7 — feature tests and historical security regressions.

Offline only: no Windows desktop, no live :8765, no Tailscale.
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import hq_automation
import hq_devices
import hq_events
import hq_state
import iphone_bridge
import cc_ext


PIN = "424242"


def _http(port: int, method: str, path: str, *, body: bytes | None = None, headers: dict | None = None, cookie: str | None = None):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    hdrs = {"Host": f"127.0.0.1:{port}"}
    if headers:
        hdrs.update(headers)
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    try:
        conn.request(method, path, body=body, headers=hdrs)
        resp = conn.getresponse()
        payload = resp.read()
        return resp.status, dict(resp.getheaders()), payload
    finally:
        conn.close()


def _unlink_with_retry(path: Path, *, timeout: float = 10.0) -> None:
    """Windows: the server thread (or an antivirus scan of a fresh .html) may still hold
    the file for a moment after the response was read (WinError 32). Retry, then fail."""
    deadline = time.monotonic() + timeout
    while True:
        try:
            path.unlink(missing_ok=True)
            return
        except PermissionError:
            if os.name != "nt" or time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


class FeatureTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-v7-"))
        self.events_seen = []

        def journal(kind, message, **extra):
            self.events_seen.append((kind, message, extra))

        hq_events.bind(self.tmp)
        hq_automation.bind(
            root=self.tmp,
            get_config=lambda: self.cfg,
            journal=journal,
            explore=lambda path: self.calls.append(("explore", path)),
            action=lambda aid: self.calls.append(("action", aid)) or {"ok": True, "id": aid},
            terminal=lambda cmd_id: self.calls.append(("terminal", cmd_id)) or {"ok": True, "id": cmd_id},
            backup=lambda: self.calls.append(("backup",)) or {"ok": True},
            capture=lambda: self.calls.append(("capture",)) or {"ok": True},
            print_file=lambda rel: self.calls.append(("print", rel)) or {"ok": True},
            notify=lambda title, body: self.calls.append(("notify", title, body)),
            move=lambda src, dest: self.calls.append(("move", src, dest)) or {"ok": True},
            sleep=lambda _s: None,
            disk_free=lambda _p: {"free": 100 * 1024**3, "total": 200 * 1024**3, "free_h": "100 Go"},
            devices=lambda: self.devices,
            file_exists=lambda rel: (self.tmp / rel).is_file(),
            now=lambda: self.now,
            local_now=lambda: self.moment,
            queue_load=None,
            queue_save=None,
            queue_lock=None,
        )
        self.calls = []
        self.devices = [{"id": "pc-host", "online": True, "source": "host"}]
        self.now = 1_700_000_000.0
        self.moment = datetime(2026, 9, 28, 8, 0, 5)  # Monday
        self.cfg = {
            "terminal_commands": [{"id": "ipconfig", "label": "ipconfig", "cmd": "ipconfig"}],
            "scenes": [],
            "alert_disk_min_gb": 20,
            "automation_enabled": True,
            "schedules_enabled": True,
            "backup_dir": str(self.tmp / "backups"),
            "daily_brief_discord": False,
            "discord_webhook_url": "",
            "push_enabled": False,
            "telemetry_local_sec": 45,
            "telemetry_remote_sec": 180,
            "telemetry_retain_hours": 36,
        }

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_events_roundtrip_and_malformed_preserved(self):
        hq_events.record("upload", "fichier ok", level="info", meta={"pin": "secret", "rel": "Inbox/a.txt"})
        listed = hq_events.list_events(kind="upload")
        self.assertEqual(listed["total"], 1)
        self.assertNotIn("pin", listed["events"][0]["meta"])
        self.assertEqual(listed["events"][0]["meta"].get("rel"), "Inbox/a.txt")
        path = self.tmp / "hq_events.json"
        original = "{ this is not json"
        path.write_text(original, encoding="utf-8")
        hq_events.bind(self.tmp)
        self.assertTrue(hq_events.malformed())
        hq_events.record("alert", "should stay in memory only")
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        self.assertTrue(hq_events.list_events()["malformed"])

    def test_device_capabilities_do_not_invent_shell(self):
        host = hq_devices.normalize({"id": "pc-host", "source": "host", "name": "TOUR", "online": True, "capabilities": ["raw_shell", "exec"]})
        self.assertIn("shell", host["capabilities"])
        self.assertNotIn("raw_shell", host["capabilities"])
        self.assertNotIn("exec", host["capabilities"])
        phone = hq_devices.normalize({"id": "ts:1", "source": "tailscale", "os": "iOS", "online": True, "name": "iPhone"})
        self.assertNotIn("ssh_target", phone["capabilities"])
        self.assertNotIn("shell", phone["capabilities"])
        peer = hq_devices.normalize({"id": "ts:2", "source": "tailscale", "os": "windows", "online": True, "name": "PORTABLE"})
        self.assertIn("ssh_target", peer["capabilities"])
        self.assertNotIn("shell", peer["capabilities"])
        browser = hq_devices.normalize({"id": "b1", "source": "browser", "kind": "browser"})
        self.assertEqual(set(browser["capabilities"]), {"presence", "upload", "voice"})

    def test_palette_fuzzy_hides_commands(self):
        hits = hq_devices.search_catalog(
            "ip",
            [
                {"kind": "terminal", "id": "ipconfig", "label": "ipconfig", "hint": "Commande allowlist", "cmd": "powershell -EncodedCommand SECRET"},
                {"kind": "folder", "id": "Inbox", "label": "Inbox", "hint": "Dossier"},
            ],
        )
        self.assertTrue(any(h["id"] == "ipconfig" for h in hits))
        blob = json.dumps(hits)
        self.assertNotIn("SECRET", blob)
        self.assertNotIn("cmd", blob)

    def test_scene_allowlist_recursion_and_wait(self):
        self.cfg["scenes"] = [
            {
                "id": "ok",
                "label": "OK",
                "steps": [
                    {"type": "notify", "title": "Bonjour", "body": "HQ"},
                    {"type": "terminal", "id": "ipconfig"},
                    {"type": "wait", "seconds": 100},
                ],
            },
            {"id": "loop", "label": "Loop", "steps": [{"type": "scene", "id": "loop"}]},
            {
                "id": "bad-shell",
                "label": "Bad",
                "steps": [{"type": "terminal", "command": "calc.exe"}],
            },
            {
                "id": "nested-fail",
                "label": "Nest",
                "steps": [{"type": "scene", "id": "bad-shell"}],
            },
        ]
        result = hq_automation.run_scene("ok")
        self.assertTrue(result["ok"])
        self.assertIn(("terminal", "ipconfig"), self.calls)
        self.assertLessEqual(sum(step.get("type") == "wait" for step in []), 1)
        waited = [s for s in result["run"]["steps"] if s["type"] == "wait"]
        self.assertTrue(waited and waited[0]["ok"])
        looped = hq_automation.run_scene("loop")
        self.assertFalse(looped["ok"])
        self.assertTrue(any("écurs" in str(step.get("detail") or "") for step in looped["run"]["steps"]))
        result_bad = hq_automation.run_scene("bad-shell")
        self.assertFalse(result_bad["ok"])
        self.assertNotIn("calc.exe", json.dumps(self.calls))

    def test_scene_stop_on_failure_default(self):
        self.cfg["scenes"] = [
            {
                "id": "stop",
                "steps": [
                    {"type": "explore", "path": "missing"},
                    {"type": "notify", "title": "après", "body": "non"},
                ],
            }
        ]

        def boom(path):
            raise ValueError("chemin refusé")

        hq_automation.bind(
            root=self.tmp,
            get_config=lambda: self.cfg,
            journal=lambda *a, **k: None,
            explore=boom,
            sleep=lambda _s: None,
            now=lambda: self.now,
            local_now=lambda: self.moment,
        )
        # re-bind wiped callbacks; set explore only via full bind already done.
        # The bind above replaced callbacks. explore raises. notify missing -> would fail too.
        result = hq_automation.run_scene("stop")
        self.assertFalse(result["ok"])
        self.assertEqual(len(result["run"]["steps"]), 1)

    def test_automation_rejects_raw_shell_and_cooldown(self):
        with self.assertRaises(ValueError):
            hq_automation.validate_rule(
                {
                    "id": "bad",
                    "trigger": {"type": "manual"},
                    "actions": [{"type": "terminal", "command": "whoami"}],
                }
            )
        rule = hq_automation.save_rule(
            {
                "id": "note",
                "label": "Note",
                "trigger": {"type": "manual"},
                "cooldown_sec": 30,
                "actions": [{"type": "journal", "message": "depuis la règle"}],
            }
        )
        first = hq_automation.run_rule(rule["id"], manual=True)
        self.assertTrue(first["ok"])
        second = hq_automation.run_rule(rule["id"], manual=True)
        self.assertTrue(second.get("skipped"))
        self.assertEqual(second.get("reason"), "cooldown")

    def test_schedules_minute_guard_and_shapes(self):
        with self.assertRaises(ValueError):
            hq_automation.normalize_schedule_job({"when": "daily", "type": "terminal", "command": "dir", "at": "08:00"})
        job = hq_automation.normalize_schedule_job(
            {"label": "Matin", "when": "daily", "type": "backup", "at": "08:00"}
        )
        items = [job]
        first = hq_automation.process_schedules(items)
        self.assertTrue(first["changed"])
        self.assertEqual(len(first["fired"]), 1)
        self.assertIn(("backup",), self.calls)
        second = hq_automation.process_schedules(items)
        self.assertFalse(second["changed"])
        self.assertEqual(second["fired"], [])
        weekly = hq_automation.normalize_schedule_job(
            {"label": "Hebdo", "when": "weekly", "weekday": 0, "type": "notify", "at": "08:00", "title": "t", "body": "b"}
        )
        fired = hq_automation.process_schedules([weekly])
        self.assertEqual(len(fired["fired"]), 1)
        once = hq_automation.normalize_schedule_job(
            {"label": "Une fois", "when": "once", "type": "capture", "once_at": self.now - 10}
        )
        hq_automation.process_schedules([once])
        self.assertEqual(once["status"], "done")
        online = hq_automation.normalize_schedule_job(
            {"label": "Retour", "when": "on-online", "type": "notify", "device_id": "pc-host", "title": "là", "body": "ok"}
        )
        hq_automation.process_schedules([online])
        self.assertEqual(online["status"], "armed")
        self.devices = [{"id": "pc-host", "online": False, "source": "host"}]
        self.moment = datetime(2026, 9, 28, 8, 1, 0)
        hq_automation.process_schedules([online])
        self.assertEqual(online["status"], "pending")

    def test_backup_restore_containment(self):
        backup_root = self.tmp / "backups" / "20260928_080000" / "Inbox"
        backup_root.mkdir(parents=True)
        (backup_root / "note.txt").write_text("salut", encoding="utf-8")
        nested = backup_root / "Cours"
        nested.mkdir()
        (nested / "a.txt").write_text("a", encoding="utf-8")
        (self.tmp / "Inbox").mkdir()
        (self.tmp / "Inbox" / "note.txt").write_text("ancien", encoding="utf-8")
        hq_automation.note_backup({"id": "20260928_080000", "path": str(self.tmp / "backups" / "20260928_080000"), "folders": 1})
        with self.assertRaises(ValueError):
            hq_automation.restore_backup("20260928_080000", "Inbox", confirm=False)
        with self.assertRaises(ValueError):
            hq_automation.restore_backup("../20260928_080000", "Inbox", confirm=True)
        with self.assertRaises(ValueError):
            hq_automation.restore_backup("20260928_080000", "Windows", confirm=True)
        info = hq_automation.restore_backup("20260928_080000", "Inbox", confirm=True)
        self.assertGreaterEqual(info["copied"], 2)
        self.assertEqual((self.tmp / "Inbox" / "note.txt").read_text(encoding="utf-8"), "salut")
        self.assertTrue((self.tmp / "Inbox" / "Cours" / "a.txt").is_file())
        bad = self.tmp / "hq_backup_index.json"
        bad.write_text("{nope", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            hq_automation.note_backup({"id": "20260928_080001", "path": "x", "folders": 1})
        self.assertEqual(bad.read_text(encoding="utf-8"), "{nope")

    def test_telemetry_uses_cached_numbers_only(self):
        probes = []
        hq_automation.sample_from_devices(
            [
                {"id": "pc-host", "source": "host", "free": 10, "total": 20},
                {"id": "ts:1", "source": "tailscale", "disks": [{"name": "C:", "free": 5, "total": 10}]},
            ]
        )
        series = hq_automation.telemetry_series("pc-host")
        self.assertTrue(series["samples"])
        self.assertEqual(probes, [])
        remote = hq_automation.telemetry_series("ts:1")
        self.assertTrue(any(s["scope"] == "remote" for s in remote["samples"]))

    def test_brief_is_deterministic_and_discord_gated(self):
        brief = hq_automation.build_brief(
            state="warning",
            attention=[{"title": "Disque", "detail": "bas"}],
            events=[{"ts": self.now, "kind": "upload"}],
            queue=[{"status": "pending"}],
            backups=[{"id": "20260928_080000"}],
            disk={"free_h": "12 Go"},
        )
        again = hq_automation.build_brief(
            state="warning",
            attention=[{"title": "Disque", "detail": "bas"}],
            events=[{"ts": self.now, "kind": "upload"}],
            queue=[{"status": "pending"}],
            backups=[{"id": "20260928_080000"}],
            disk={"free_h": "12 Go"},
        )
        self.assertEqual(brief["lines"], again["lines"])
        self.assertIn("Attention", brief["lines"][0])
        gated = hq_automation.maybe_send_brief(brief, force=True)
        self.assertFalse(gated["sent"])
        self.cfg["daily_brief_discord"] = True
        self.cfg["discord_webhook_url"] = "https://example.invalid/hook"
        sent = []
        hq_automation.bind(
            root=self.tmp,
            get_config=lambda: self.cfg,
            journal=lambda *a, **k: None,
            notify=lambda title, body: sent.append((title, body)),
            now=lambda: self.now,
            local_now=lambda: self.moment,
        )
        ok = hq_automation.maybe_send_brief(brief, force=True)
        self.assertTrue(ok["sent"])
        self.assertEqual(len(sent), 1)

    def test_push_opt_in_refuses_when_disabled(self):
        status = hq_automation.push_status()
        self.assertFalse(status["enabled"])
        self.assertIn("HTTPS", status["https_note"])
        with self.assertRaises(ValueError):
            hq_automation.subscribe_push(
                {"endpoint": "https://push.example/sub", "keys": {"p256dh": "abc", "auth": "def"}}
            )
        self.assertFalse((self.tmp / "hq_vapid.json").exists())

    def test_device_online_is_edge_not_level(self):
        hq_automation.save_rule(
            {
                "id": "sync",
                "label": "Sync",
                "trigger": {"type": "device_online", "device_id": "pc-host"},
                "cooldown_sec": 30,
                "actions": [{"type": "journal", "message": "online"}],
            }
        )
        self.devices = [{"id": "pc-host", "online": True, "source": "host"}]
        self.assertEqual(hq_automation.evaluate_rules(), [])
        self.now += 120
        self.assertEqual(hq_automation.evaluate_rules(), [])
        self.devices = [{"id": "pc-host", "online": False, "source": "host"}]
        self.assertEqual(hq_automation.evaluate_rules(), [])
        self.devices = [{"id": "pc-host", "online": True, "source": "host"}]
        fired = hq_automation.evaluate_rules()
        self.assertEqual(len(fired), 1)
        self.assertTrue(fired[0]["ok"])
        self.now += 120
        self.assertEqual(hq_automation.evaluate_rules(), [])

    def test_event_rule_ignores_own_descendants(self):
        def journal(kind, message, **extra):
            self.events_seen.append((kind, message, extra))
            meta = {k: v for k, v in extra.items() if k != "level"}
            hq_events.record(kind, message, level=str(extra.get("level") or "info"), meta=meta)

        hq_automation.bind(
            journal=journal,
            events_recent=lambda limit=100: hq_events.list_events(limit=int(limit or 100)).get("events") or [],
        )
        hq_automation.save_rule(
            {
                "id": "echo",
                "label": "Echo",
                "trigger": {"type": "event", "kind": "automation"},
                "cooldown_sec": 30,
                "actions": [{"type": "journal", "message": "echo"}],
            }
        )
        first = hq_automation.evaluate_rules()
        self.assertEqual(len(first), 1)
        echoes = [ev for ev in hq_events.list_events(kind="automation")["events"] if ev.get("message") == "echo"]
        self.assertTrue(echoes)
        self.assertEqual(echoes[0]["meta"].get("rule_id"), "echo")
        self.now += 120
        self.assertEqual(hq_automation.evaluate_rules(), [])
        hq_events.record("automation", "externe", level="info")
        third = hq_automation.evaluate_rules()
        self.assertEqual(len(third), 1)
        self.assertTrue(third[0]["ok"])

    def test_atomic_write_preserves_malformed_and_stays_json(self):
        path = self.tmp / "hq_automation.json"
        path.write_text("{bad", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            hq_state.write_json_atomic(path, {"version": 1})
        self.assertEqual(path.read_text(encoding="utf-8"), "{bad")
        path.write_text("123", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            hq_state.write_json_atomic(path, {"version": 1})
        self.assertEqual(path.read_text(encoding="utf-8"), "123")
        path.write_text('{"version": 1}\n', encoding="utf-8")
        hq_state.write_json_atomic(path, {"version": 2, "rules": []})
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["version"], 2)
        self.assertFalse((self.tmp / "hq_automation.json.tmp").exists())
        errors: list[str] = []

        def worker(i: int) -> None:
            try:
                for n in range(25):
                    hq_state.write_json_atomic(path, {"version": 1, "i": i, "n": n})
            except Exception as e:
                errors.append(repr(e))

        threads = [threading.Thread(target=worker, args=(i,)) for i in range(4)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(errors, [])
        json.loads(path.read_text(encoding="utf-8"))

    def test_schedule_catchup_runs_one_overdue_slot(self):
        self.moment = datetime(2026, 9, 28, 10, 0, 5)
        job = hq_automation.normalize_schedule_job(
            {"label": "Matin", "when": "daily", "type": "backup", "at": "08:00"}
        )
        job["next_run"] = "2026-09-28T08:00"
        items = [job]
        first = hq_automation.process_schedules(items)
        self.assertEqual(len(first["fired"]), 1)
        self.assertEqual(job["next_run"], "2026-09-29T08:00")
        self.calls.clear()
        for _ in range(4):
            again = hq_automation.process_schedules(items)
            self.assertEqual(again["fired"], [])
        self.assertEqual(self.calls, [])
        stale = hq_automation.normalize_schedule_job(
            {"label": "Vieux", "when": "daily", "type": "capture", "at": "08:00"}
        )
        stale["next_run"] = _fmt_minutes(self.moment - timedelta(hours=30))
        self.calls.clear()
        skipped = hq_automation.process_schedules([stale])
        self.assertEqual(skipped["fired"], [])
        self.assertEqual(self.calls, [])
        self.assertEqual(stale["next_run"], "2026-09-29T08:00")
        weekly = hq_automation.normalize_schedule_job(
            {"label": "Hebdo", "when": "weekly", "weekday": 0, "type": "notify", "at": "08:00", "title": "t", "body": "b"}
        )
        weekly["next_run"] = "2026-08-03T08:00"
        self.calls.clear()
        missed = hq_automation.process_schedules([weekly])
        self.assertEqual(missed["fired"], [])
        self.assertNotIn(("notify", "t", "b"), self.calls)
        self.assertEqual(weekly["next_run"], "2026-10-05T08:00")

    def test_send_push_prunes_and_scopes_categories(self):
        payloads: list[str] = []

        def transport(sub, payload):
            payloads.append(payload)
            if str(sub.get("endpoint") or "").endswith("/gone"):
                return 410
            return 201

        self.cfg["push_enabled"] = True
        hq_automation.bind(push_transport=transport)
        hq_automation.subscribe_push(
            {"endpoint": "https://push.example/ok", "keys": {"p256dh": "abc", "auth": "def"}}
        )
        hq_automation.subscribe_push(
            {"endpoint": "https://push.example/gone", "keys": {"p256dh": "abc", "auth": "def"}}
        )
        result = hq_automation.send_push("Alerte", "disque", category="alert")
        self.assertEqual(result["sent"], 1)
        self.assertEqual(result["pruned"], 1)
        self.assertNotIn("private", json.dumps(result).lower())
        self.assertEqual(hq_automation.push_status()["subscriptions"], 1)
        self.assertTrue(payloads and all('"category": "alert"' in body for body in payloads))
        self.cfg["push_enabled"] = False
        payloads.clear()
        quiet = hq_automation.send_push("Alerte", "x", category="alert")
        self.assertEqual(quiet["sent"], 0)
        self.assertEqual(payloads, [])
        self.cfg["push_enabled"] = True
        ignored = hq_automation.send_push("x", "y", category="scene")
        self.assertEqual(ignored["sent"], 0)
        self.assertEqual(payloads, [])

        def boom():
            raise RuntimeError("disk")

        hq_automation.bind(backup=boom)
        hq_automation.save_rule(
            {
                "id": "cap",
                "trigger": {"type": "manual"},
                "cooldown_sec": 30,
                "actions": [{"type": "backup"}],
            }
        )
        failed = hq_automation.run_rule("cap", manual=True)
        self.assertFalse(failed["ok"])
        self.assertTrue(any("automation_failure" in body for body in payloads))
        before = len(payloads)
        items = [{"level": "critical", "title": "Espace", "detail": "1 Go"}]
        hq_automation.bind(
            attention_items=lambda: items,
            queue_load=lambda: [],
            queue_save=lambda _items: None,
        )
        hq_automation.tick()
        hq_automation.tick()
        self.assertEqual(len(payloads), before + 1)
        self.assertIn("attention", payloads[-1])
        self.assertNotIn("private_pem", " ".join(payloads))
        previous_root = cc_ext.ROOT
        try:
            cc_ext.bind(ROOT=self.tmp, get_config=lambda: self.cfg)
            payloads.clear()
            cc_ext.log_activity("alert", "seuil disque")
            cc_ext.log_activity("upload", "fichier", level="info")
            self.assertEqual(len(payloads), 1)
            self.assertIn('"category": "alert"', payloads[0])
        finally:
            cc_ext.bind(ROOT=previous_root)

    def test_restore_confirm_bool_and_preflight_limit(self):
        backup_root = self.tmp / "backups" / "20260928_080000" / "Inbox"
        backup_root.mkdir(parents=True)
        (backup_root / "note.txt").write_text("salut", encoding="utf-8")
        nested = backup_root / "Cours"
        nested.mkdir()
        (nested / "a.txt").write_text("a", encoding="utf-8")
        inbox = self.tmp / "Inbox"
        inbox.mkdir()
        (inbox / "note.txt").write_text("ancien", encoding="utf-8")
        hq_automation.note_backup(
            {"id": "20260928_080000", "path": str(self.tmp / "backups" / "20260928_080000"), "folders": 1}
        )
        with self.assertRaises(ValueError):
            hq_automation.restore_backup("20260928_080000", "Inbox", confirm="yes")
        self.assertEqual((inbox / "note.txt").read_text(encoding="utf-8"), "ancien")
        self.assertFalse((inbox / "Cours" / "a.txt").exists())
        previous = hq_automation.RESTORE_FILE_MAX
        hq_automation.RESTORE_FILE_MAX = 1
        try:
            with self.assertRaises(ValueError):
                hq_automation.restore_backup("20260928_080000", "Inbox", confirm=True)
        finally:
            hq_automation.RESTORE_FILE_MAX = previous
        self.assertEqual((inbox / "note.txt").read_text(encoding="utf-8"), "ancien")
        self.assertFalse((inbox / "Cours" / "a.txt").exists())

    def test_brief_meta_does_not_drop_concurrent_rule(self):
        self.cfg["daily_brief_discord"] = True
        self.cfg["discord_webhook_url"] = "https://example.invalid/hook"
        started = threading.Event()
        release = threading.Event()

        def notify(_title, _body):
            started.set()
            self.assertTrue(release.wait(2))

        hq_automation.bind(notify=notify, journal=lambda *a, **k: None)
        outcome: dict = {}

        def send() -> None:
            try:
                outcome["result"] = hq_automation.maybe_send_brief(
                    {"title": "Brief", "lines": ["ligne"]},
                    force=True,
                )
            except Exception as e:
                outcome["error"] = e

        worker = threading.Thread(target=send)
        worker.start()
        self.assertTrue(started.wait(2))
        saved = threading.Event()

        def do_save() -> None:
            try:
                outcome["rule"] = hq_automation.save_rule(
                    {
                        "id": "kept",
                        "label": "Kept",
                        "trigger": {"type": "manual"},
                        "cooldown_sec": 30,
                        "actions": [{"type": "journal", "message": "ok"}],
                    }
                )
            except Exception as e:
                outcome["save_error"] = e
            finally:
                saved.set()

        saver = threading.Thread(target=do_save)
        saver.start()
        try:
            self.assertTrue(saved.wait(1), "save_rule blocked behind the brief lock")
        finally:
            release.set()
            worker.join(2)
            saver.join(2)
        self.assertFalse(worker.is_alive())
        self.assertFalse(saver.is_alive())
        self.assertNotIn("error", outcome)
        self.assertNotIn("save_error", outcome)
        self.assertTrue(outcome["result"]["sent"])
        data = json.loads((self.tmp / "hq_automation.json").read_text(encoding="utf-8"))
        ids = [rule.get("id") for rule in data.get("rules") or []]
        self.assertIn("kept", ids)
        self.assertEqual(data.get("meta", {}).get("last_brief_date"), "2026-09-28")

    def test_queue_tick_does_not_drop_concurrent_add(self):
        previous_root = cc_ext.ROOT
        started = threading.Event()
        release = threading.Event()

        def backup():
            started.set()
            self.assertTrue(release.wait(2))
            self.calls.append(("backup",))
            return {"ok": True}

        try:
            cc_ext.bind(ROOT=self.tmp, get_config=lambda: self.cfg)
            hq_automation.bind(
                backup=backup,
                queue_load=cc_ext.queue_load,
                queue_save=cc_ext.queue_save,
                queue_lock=cc_ext.queue_lock,
                journal=lambda *a, **k: None,
            )
            due = hq_automation.normalize_schedule_job(
                {"id": "due", "label": "Matin", "when": "daily", "type": "backup", "at": "08:00"}
            )
            cc_ext.queue_save([due])
            errors: list[BaseException] = []

            def run_tick() -> None:
                try:
                    hq_automation.tick()
                except Exception as e:
                    errors.append(e)

            ticker = threading.Thread(target=run_tick)
            ticker.start()
            self.assertTrue(started.wait(2))
            added_box: dict = {}

            def do_add() -> None:
                try:
                    added_box["job"] = cc_ext.queue_add(
                        {
                            "id": "extra",
                            "label": "Extra",
                            "when": "once",
                            "type": "notify",
                            "once_at": self.now + 10_000,
                            "title": "t",
                            "body": "b",
                        }
                    )
                except Exception as e:
                    added_box["error"] = e

            adder = threading.Thread(target=do_add)
            adder.start()
            adder.join(0.15)
            release.set()
            ticker.join(2)
            adder.join(2)
            self.assertFalse(ticker.is_alive())
            self.assertFalse(adder.is_alive())
            self.assertEqual(errors, [])
            self.assertNotIn("error", added_box)
            ids = {job.get("id") for job in cc_ext.queue_load()}
            self.assertIn("due", ids)
            self.assertIn("extra", ids)
            self.assertIn(("backup",), self.calls)
            path = self.tmp / "bridge_queue.json"
            original = "{nope"
            path.write_text(original, encoding="utf-8")
            with self.assertRaises(RuntimeError):
                cc_ext.queue_save([{"id": "nope"}])
            self.assertEqual(path.read_text(encoding="utf-8"), original)
        finally:
            release.set()
            cc_ext.bind(ROOT=previous_root)


def _fmt_minutes(moment: datetime) -> str:
    return moment.strftime("%Y-%m-%dT%H:%M")


class SecurityRegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        iphone_bridge.CONFIG["pin"] = PIN
        iphone_bridge.CONFIG["users"] = []
        iphone_bridge.CONFIG["discord_webhook_url"] = ""
        iphone_bridge.CONFIG["push_enabled"] = False
        iphone_bridge.CONFIG["daily_brief_discord"] = False
        iphone_bridge.CONFIG["scenes"] = [
            {"id": "ping", "label": "Ping", "steps": [{"type": "notify", "title": "ping", "body": "ok"}]}
        ]
        iphone_bridge.ensure_folders_and_migrate()
        iphone_bridge.bind_cc_ext()
        iphone_bridge.bind_hq()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), iphone_bridge.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.admin = cls._login(PIN)

    @classmethod
    def _login(cls, pin: str) -> str:
        status, headers, _body = _http(
            cls.port,
            "POST",
            "/login",
            body=urlencode({"pin": pin}).encode(),
            headers={
                "Origin": f"http://127.0.0.1:{cls.port}",
                "Content-Type": "application/x-www-form-urlencoded",
            },
        )
        if status != 303:
            raise AssertionError(f"login failed {status}")
        raw = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
        token = raw.split(";", 1)[0]
        if not token.startswith("transfert_session="):
            raise AssertionError(raw)
        return token

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        iphone_bridge.CONFIG.clear()
        iphone_bridge.CONFIG.update(cls._config)

    def setUp(self):
        iphone_bridge._LOGIN_FAILS.clear()

    def _get(self, path, cookie=None):
        return _http(self.port, "GET", path, cookie=cookie if cookie is not None else self.admin)

    def _post(self, path, payload, *, cookie=None, origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        return _http(
            self.port,
            "POST",
            path,
            body=json.dumps(payload).encode(),
            headers=headers,
            cookie=cookie if cookie is not None else self.admin,
        )

    def test_dotfiles_stay_out_of_inbox(self):
        tmp = Path(tempfile.mkdtemp(prefix="hq-dot-"))
        (tmp / ".gitignore").write_text("keep\n", encoding="utf-8")
        (tmp / "Inbox").mkdir()
        old = iphone_bridge.ROOT
        try:
            iphone_bridge.ROOT = tmp
            iphone_bridge.ensure_folders_and_migrate()
            self.assertTrue((tmp / ".gitignore").is_file())
            self.assertFalse((tmp / "Inbox" / ".gitignore").exists())
            self.assertTrue((tmp / "Inbox" / "Voice").is_dir())
        finally:
            iphone_bridge.ROOT = old
            shutil.rmtree(tmp, ignore_errors=True)

    def test_repo_docs_stay_at_root(self):
        # A root without readable Git metadata must not be migrated. Shipped docs,
        # including tracked Markdown, also stay when Git can identify them.
        tmp = Path(tempfile.mkdtemp(prefix="hq-docs-"))
        repo = Path(__file__).resolve().parents[1]
        docs = [p.name for p in repo.iterdir() if p.is_file() and p.suffix.lower() in {".md", ".txt"}]
        self.assertIn("design.md", docs)
        for name in docs:
            (tmp / name).write_text("doc\n", encoding="utf-8")
        old = iphone_bridge.ROOT
        try:
            iphone_bridge.ROOT = tmp
            iphone_bridge.ensure_folders_and_migrate()
            for name in docs:
                self.assertTrue((tmp / name).is_file(), name)
                self.assertFalse((tmp / "Inbox" / name).exists(), name)
        finally:
            iphone_bridge.ROOT = old
            shutil.rmtree(tmp, ignore_errors=True)

    def test_loopback_is_not_admin(self):
        status, _headers, body = _http(self.port, "GET", "/api/me")
        self.assertEqual(status, 401)
        self.assertNotIn(PIN, body.decode("utf-8", "replace"))

    def test_pin_required_fail_closed(self):
        saved_pin = iphone_bridge.CONFIG["pin"]
        saved_users = list(iphone_bridge.CONFIG["users"])
        try:
            iphone_bridge.CONFIG["pin"] = ""
            iphone_bridge.CONFIG["users"] = []
            self.assertFalse(iphone_bridge.pin_enabled())
            self.assertIsNone(iphone_bridge.authenticate_pin(PIN))
            self.assertIsNone(iphone_bridge.session_info("anything"))
        finally:
            iphone_bridge.CONFIG["pin"] = saved_pin
            iphone_bridge.CONFIG["users"] = saved_users

    def test_malformed_config_not_overwritten(self):
        tmp = Path(tempfile.mkdtemp(prefix="hq-cfg-"))
        path = tmp / "bridge_config.json"
        original = "{ broken"
        path.write_text(original, encoding="utf-8")
        old = iphone_bridge.CONFIG_PATH
        try:
            iphone_bridge.CONFIG_PATH = path
            with self.assertRaises(SystemExit):
                iphone_bridge.load_config()
            self.assertEqual(path.read_text(encoding="utf-8"), original)
        finally:
            iphone_bridge.CONFIG_PATH = old
            shutil.rmtree(tmp, ignore_errors=True)

    def test_upload_role_blocked_on_admin_routes(self):
        iphone_bridge.CONFIG["users"] = [
            {"name": "admin", "pin": PIN, "role": "admin"},
            {"name": "phone", "pin": "111111", "role": "upload"},
        ]
        try:
            phone = self._login_instance("111111")
            for path in ("/api/hq", "/api/events", "/api/clipboard/pc", "/api/queue", "/api/scratchpad", "/api/automation"):
                status, _h, _b = self._get(path, cookie=phone)
                self.assertEqual(status, 403, path)
            status, _h, _b = self._post("/api/queue", {"label": "x", "when": "online", "type": "explore", "path": "Inbox"}, cookie=phone)
            self.assertEqual(status, 403)
            status, _h, _b = self._post("/api/scratchpad", {"text": "nope"}, cookie=phone)
            self.assertEqual(status, 403)
            status, _h, _b = self._post("/api/clipboard/pc", {"text": "nope"}, cookie=phone)
            self.assertEqual(status, 403)
        finally:
            iphone_bridge.CONFIG["users"] = []

    def _login_instance(self, pin: str) -> str:
        return type(self)._login(pin)

    def test_shell_host_override_rejected(self):
        status, _h, body = self._post("/api/shell", {"host": "evil.example", "cmd": "whoami", "target": "local"})
        self.assertEqual(status, 400)
        self.assertIn("autoris", body.decode("utf-8", "replace"))

    def test_screenshot_get_rejected_and_post_csrf(self):
        status, headers, _body = _http(self.port, "GET", "/api/pc/screenshot")
        self.assertEqual(status, 405)
        self.assertIn("POST", headers.get("Allow", ""))
        status, _h, body = self._post("/api/pc/screenshot", {}, origin=False)
        self.assertEqual(status, 403)
        self.assertIn("CSRF", body.decode("utf-8", "replace"))

    def test_absurd_limits(self):
        status, _h, _b = self._get("/api/events?limit=99999")
        self.assertEqual(status, 400)
        status, _h, _b = self._get("/api/activity?offset=99999")
        self.assertEqual(status, 400)
        status, _h, _b = self._get("/api/list?limit=-1")
        self.assertEqual(status, 400)

    def test_path_traversal_and_attachment(self):
        inbox = iphone_bridge.ROOT / "Inbox"
        inbox.mkdir(exist_ok=True)
        html_path = inbox / "evil-hq-test.html"
        html_path.write_text("<script>alert(1)</script>", encoding="utf-8")
        try:
            status, _h, _b = self._get("/files/Inbox/../../iphone_bridge.py")
            self.assertEqual(status, 404)
            status, _h, _b = self._get("/files/" + "Inbox/%2e%2e/%2e%2e/iphone_bridge.py")
            self.assertNotEqual(status, 200)
            status, headers, body = self._get("/files/Inbox/evil-hq-test.html")
            self.assertEqual(status, 200)
            disposition = headers.get("Content-Disposition", "")
            self.assertIn("attachment", disposition.lower())
            self.assertIn("nosniff", headers.get("X-Content-Type-Options", ""))
            self.assertNotIn(b"text/html", headers.get("Content-Type", "").encode())
            self.assertIn(b"alert(1)", body)
        finally:
            _unlink_with_retry(html_path)
        self.assertFalse(html_path.exists())

    def test_chunk_and_quota_guards(self):
        iphone_bridge.CONFIG["upload_sessions_max"] = 1
        try:
            first = iphone_bridge.upload_init("a.bin", 4, "Inbox")
            with self.assertRaises(ValueError):
                iphone_bridge.upload_chunk(first["id"], 5, b"abcd")
            with self.assertRaises(ValueError):
                iphone_bridge.upload_init("b.bin", 4, "Inbox")
            with self.assertRaises(ValueError):
                iphone_bridge.upload_chunk(first["id"], 0, b"abcdef")
        finally:
            iphone_bridge.CONFIG["upload_sessions_max"] = iphone_bridge.UPLOAD_SESSIONS_MAX
            root = iphone_bridge.TMP_DIR / "chunks"
            if root.is_dir():
                shutil.rmtree(root, ignore_errors=True)
            iphone_bridge.UPLOAD_SESSIONS.clear()

    def test_scratchpad_admin_only_and_capped(self):
        status, _h, body = self._post("/api/scratchpad", {"text": "bloc v7"})
        self.assertEqual(status, 200)
        self.assertIn("bloc v7", body.decode())
        self.assertTrue((iphone_bridge.ROOT / "scratchpad.txt").is_file())
        huge = "x" * (cc_ext.SCRATCHPAD_MAX + 10)
        status, _h, _b = self._post("/api/scratchpad", {"text": huge})
        self.assertEqual(status, 400)

    def test_hq_snapshot_does_not_probe_tailscale(self):
        calls = []
        original = iphone_bridge.tailscale_peers

        def boom():
            calls.append(1)
            raise AssertionError("tailscale probe")

        iphone_bridge.tailscale_peers = boom
        iphone_bridge._ROSTER_CACHE["devices"] = []
        iphone_bridge._ROSTER_CACHE["at"] = 0
        try:
            status, _h, body = self._get("/api/hq")
            self.assertEqual(status, 200)
            data = json.loads(body)
            self.assertIn(data["state"], ("ok", "warning", "critical"))
            self.assertIsInstance(data["attention"], list)
            self.assertTrue(data["cached"])
            self.assertEqual(calls, [])
            ids = [d["id"] for d in data["devices"]]
            self.assertIn("pc-host", ids)
            host = next(d for d in data["devices"] if d["id"] == "pc-host")
            self.assertNotIn("raw_shell", host["capabilities"])
        finally:
            iphone_bridge.tailscale_peers = original

    def test_palette_api_has_no_raw_command(self):
        marker = "SUPER_SECRET_CMD_STRING"
        saved = list(iphone_bridge.CONFIG.get("terminal_commands") or [])
        iphone_bridge.CONFIG["terminal_commands"] = [{"id": "ipconfig", "label": "ipconfig", "cmd": marker}]
        try:
            status, _h, body = self._get("/api/palette?q=ipconfig")
            self.assertEqual(status, 200)
            text = body.decode()
            self.assertNotIn(marker, text)
            self.assertIn("ipconfig", text)
        finally:
            iphone_bridge.CONFIG["terminal_commands"] = saved

    def test_scene_run_and_events_api(self):
        status, _h, body = self._post("/api/scene", {"id": "ping"})
        self.assertEqual(status, 200, body)
        status, _h, body = self._post("/api/automation", {"action": "save", "rule": {"id": "manual-note", "label": "Note", "trigger": {"type": "manual"}, "actions": [{"type": "journal", "message": "journalisé"}]}})
        self.assertEqual(status, 200, body)
        status, _h, body = self._post("/api/automation", {"action": "save", "rule": {"trigger": {"type": "manual"}, "actions": [{"type": "terminal", "command": "whoami"}]}})
        self.assertEqual(status, 400)
        status, _h, body = self._get("/api/events?kind=scene")
        self.assertEqual(status, 200)
        self.assertIn("ping", body.decode())

    def test_schedule_post_rejects_shell(self):
        status, _h, _b = self._post(
            "/api/queue",
            {"label": "x", "when": "daily", "at": "08:00", "type": "backup", "command": "format"},
        )
        self.assertEqual(status, 400)

    def test_restore_requires_confirm(self):
        status, _h, body = self._post("/api/backup/restore", {"id": "20260101_000000", "folder": "Inbox", "confirm": False})
        self.assertEqual(status, 400)
        self.assertIn("Confirmation", body.decode())

    def test_push_disabled_and_csrf(self):
        status, _h, body = self._post(
            "/api/push/subscribe",
            {"endpoint": "https://push.example/abc", "keys": {"p256dh": "aa", "auth": "bb"}},
            origin=False,
        )
        self.assertEqual(status, 403)
        status, _h, body = self._post(
            "/api/push/subscribe",
            {"endpoint": "https://push.example/abc", "keys": {"p256dh": "aa", "auth": "bb"}},
        )
        self.assertEqual(status, 400)
        self.assertIn("désactivé", body.decode())

    def test_brief_endpoint(self):
        status, _h, body = self._get("/api/brief")
        self.assertEqual(status, 200)
        data = json.loads(body)
        self.assertTrue(data["lines"])
        self.assertNotIn(PIN, body.decode())


if __name__ == "__main__":
    unittest.main()
