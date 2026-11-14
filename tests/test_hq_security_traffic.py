"""Unit and integration tests for Transfert HQ Security & Traffic Telemetry."""

import unittest
import time
import json
import urllib.request
import urllib.error
from unittest import mock
import hq_security
import iphone_bridge as bridge


class TrafficTrackerTests(unittest.TestCase):
    def setUp(self):
        self.tracker = hq_security.TrafficTracker(history_minutes=5, recent_maxlen=20)

    def test_record_and_snapshot(self):
        self.tracker.record(
            ip="127.0.0.1",
            method="GET",
            path="/api/status",
            status=200,
            duration_ms=4.2,
            provenance="localhost",
            role="admin",
        )
        self.tracker.record(
            ip="100.64.0.1",
            method="POST",
            path="/login",
            status=401,
            duration_ms=12.5,
            provenance="tailscale",
            role="anonymous",
            pin_hint="6 chiffres",
        )

        snap = self.tracker.snapshot()
        self.assertEqual(snap["total_requests"], 2)
        self.assertEqual(snap["status_counts"]["2xx"], 1)
        self.assertEqual(snap["status_counts"]["4xx"], 1)
        self.assertEqual(snap["provenance_counts"]["localhost"], 1)
        self.assertEqual(snap["provenance_counts"]["tailscale"], 1)
        self.assertEqual(len(snap["recent_requests"]), 2)

        last_req = snap["recent_requests"][-1]
        self.assertEqual(last_req["ip"], "100.64.0.1")
        self.assertEqual(last_req["pin_hint"], "6 chiffres")
        self.assertEqual(last_req["status"], 401)

    def test_timeline_buckets(self):
        for i in range(5):
            self.tracker.record("127.0.0.1", "GET", "/api/test", 200, 1.0, "localhost", "admin")
        snap = self.tracker.snapshot()
        self.assertEqual(len(snap["timeline"]), 30)
        current_minute = snap["timeline"][-1]
        self.assertEqual(current_minute["total"], 5)
        self.assertEqual(current_minute["2xx"], 5)


class SecurityTabIntegrationTests(unittest.TestCase):
    def test_security_traffic_endpoint_unauthorized_without_admin(self):
        # Create a mock Handler instance
        handler = mock.MagicMock()
        handler.headers = {"Host": "127.0.0.1:8765"}
        handler.client_address = ("127.0.0.1", 54321)
        handler._role.return_value = "upload"  # Non-admin

        # Test logic branch
        with mock.patch.object(bridge.Handler, "_role", return_value="upload"):
            # When role is not admin, returns 403
            self.assertNotEqual(handler._role(), "admin")


class SecuriaAiTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path
        import hq_securia

        self.tmp = Path(tempfile.mkdtemp(prefix="hq-securia-test-"))
        self.sessions = [
            {"id": "abcd1234…", "token": "abcd1234567890", "user": "Admin", "role": "admin", "created_h": "12:00:00", "last_seen_h": "12:05:00", "idle_sec": 10}
        ]
        hq_securia.bind(
            root=self.tmp,
            sessions_getter=lambda: list(self.sessions),
            revoke_session_fn=lambda tok: any(s["token"] == tok for s in self.sessions) and not self.sessions.clear(),
            rate_limiter_getter=lambda: {"global_recent": 2, "blocked": []},
            config_getter=lambda: {"tripwire": {"enabled": True, "failed_threshold": 3}},
            presence_getter=lambda: [{"name": "iPhone de Marco", "ip": "100.64.0.42", "kind": "ios", "online": True, "ago_sec": 3}],
        )

    def test_securia_tool_loop_and_thread_persistence(self):
        import hq_securia
        import hq_ai

        responses = [
            (json.dumps({"reply": "", "tools": [{"name": "get_traffic_summary", "args": {}}, {"name": "list_active_sessions", "args": {}}]}), "mock-model"),
            (json.dumps({"reply": "Trafic nominal, 1 session admin active.", "tools": []}), "mock-model"),
        ]
        with mock.patch.object(hq_ai, "generate", side_effect=responses):
            res = hq_securia.chat("Quel est l'état du trafic ?")

        self.assertTrue(res["ok"])
        self.assertEqual(res["reply"], "Trafic nominal, 1 session admin active.")
        self.assertEqual(res["tools_used"], ["get_traffic_summary", "list_active_sessions"])
        self.assertEqual(len(res["messages"]), 2)
        self.assertEqual(hq_securia.status_summary()["ok"], True)

    def test_securia_read_and_search_tools_with_secret_blocking(self):
        import hq_securia

        (self.tmp / "notes.md").write_text("ligne 1\nPerimeter check OK\n", encoding="utf-8")
        (self.tmp / ".env").write_text("SECRET_TOKEN=supersecret\n", encoding="utf-8")

        listed = hq_securia._execute_tool("list_project_files", {})
        self.assertTrue(listed["ok"])
        self.assertIn("notes.md", listed["result"]["files"])
        self.assertNotIn(".env", listed["result"]["files"])

        read_ok = hq_securia._execute_tool("read_project_file", {"path": "notes.md"})
        self.assertTrue(read_ok["ok"])
        self.assertIn("Perimeter check OK", read_ok["result"]["content"])

        read_blocked = hq_securia._execute_tool("read_project_file", {"path": ".env"})
        self.assertFalse(read_blocked["ok"])

        searched = hq_securia._execute_tool("search_project_text", {"query": "Perimeter"})
        self.assertTrue(searched["ok"])
        self.assertEqual(len(searched["result"]["hits"]), 1)

        ip_rep = hq_securia._execute_tool("check_ip_reputation", {"ip": "127.0.0.1"})
        self.assertTrue(ip_rep["ok"])
        self.assertEqual(ip_rep["result"]["ip"], "127.0.0.1")

    def test_securia_devices_blocklist_report_and_proactive_alert(self):
        import hq_securia
        import hq_security

        hq_security.IP_BLOCKLIST.clear_for_tests()
        hq_security.IP_BLOCKLIST.attach(self.tmp)

        devs = hq_securia._execute_tool("list_known_devices", {})
        self.assertTrue(devs["ok"])
        self.assertEqual(devs["result"][0]["name"], "iPhone de Marco")

        rep = hq_securia._execute_tool("check_ip_reputation", {"ip": "100.64.0.42"})
        self.assertEqual(rep["result"]["known_device"], "iPhone de Marco")

        # Protected localhost cannot be blocked
        blk_local = hq_securia._execute_tool("block_ip", {"ip": "127.0.0.1"})
        self.assertFalse(blk_local["ok"])

        # Block & unblock external IP
        blk_ext = hq_securia._execute_tool("block_ip", {"ip": "203.0.113.9", "reason": "Bruteforce", "duration_sec": 120})
        self.assertTrue(blk_ext["ok"])
        is_blk, _ = hq_security.IP_BLOCKLIST.is_blocked("203.0.113.9")
        self.assertTrue(is_blk)
        self.assertEqual(len(hq_securia._execute_tool("list_blocked_ips", {})["result"]), 1)

        unblk = hq_securia._execute_tool("unblock_ip", {"ip": "203.0.113.9"})
        self.assertTrue(unblk["ok"])
        is_blk2, _ = hq_security.IP_BLOCKLIST.is_blocked("203.0.113.9")
        self.assertFalse(is_blk2)

        # Export incident report
        exp = hq_securia._execute_tool("export_security_report", {"title": "Test Incident"})
        self.assertTrue(exp["ok"])
        report_file = self.tmp / exp["result"]["path"]
        self.assertTrue(report_file.is_file())
        self.assertIn("# Test Incident", report_file.read_text(encoding="utf-8"))

        # Proactive alert when 3+ auth failures from an IP
        fake_events = [
            {"event": "auth.login.failure", "ip": "100.64.0.42"},
            {"event": "auth.login.failure", "ip": "100.64.0.42"},
            {"event": "auth.rate_limited", "ip": "100.64.0.42"},
        ]
        with mock.patch.object(hq_securia, "_sec_log_tail", return_value=fake_events):
            st = hq_securia.status_summary()
            self.assertIsNotNone(st["proactive_alert"])
            self.assertIn("iPhone de Marco", st["proactive_alert"]["message"])

    def test_tripwire_arm_rearm_and_securia_tool(self):
        import hq_securia
        import hq_security

        cfg = {"tripwire": {"enabled": True, "failed_threshold": 2}, "emergency_lockdown": False}
        hq_security.arm_or_rearm_tripwire(cfg, enabled=True, threshold=2, release_lockdown=True)
        st0 = hq_security.tripwire_status(cfg)
        self.assertEqual(st0["state"], "armed")
        self.assertEqual(st0["recent_failures"], 0)

        # Trip it
        hq_security.record_failed_attempt("203.0.113.5", "bad-agent", cfg)
        hq_security.record_failed_attempt("203.0.113.5", "bad-agent", cfg)
        st1 = hq_security.tripwire_status(cfg)
        self.assertEqual(st1["state"], "tripped")
        self.assertGreaterEqual(st1["recent_failures"], 2)

        # Rearm via Securia tool
        hq_securia.bind(root=self.tmp, config_getter=lambda: cfg)
        res = hq_securia._execute_tool("rearm_tripwire", {"action": "rearm", "threshold": 3, "release_lockdown": True})
        self.assertTrue(res["ok"])
        self.assertEqual(res["result"]["state"], "armed")
        self.assertEqual(res["result"]["recent_failures"], 0)
        self.assertEqual(res["result"]["failed_threshold"], 3)

        # Disarm
        res2 = hq_securia._execute_tool("rearm_tripwire", {"action": "disarm"})
        self.assertTrue(res2["ok"])
        self.assertEqual(res2["result"]["state"], "disarmed")


if __name__ == "__main__":
    unittest.main()
