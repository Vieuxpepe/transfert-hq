import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import hq_securia
import hq_state


def _turn(text, reply):
    return json.dumps({"reply": reply, "tools": [{"name": "get_traffic_summary", "args": {}}]} if text else {"reply": reply, "tools": []})


class TestHqSecuria(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp_root = Path(self._tmp.name)
        hq_securia.bind(root=self.tmp_root)

    def tearDown(self) -> None:
        # Back to the run's sandbox root, never the live checkout.
        hq_securia.bind(root=hq_state.state_root())
        self._tmp.cleanup()

    def _thread_file(self) -> Path:
        return self.tmp_root / ".hq-security" / "securia_thread.json"

    def test_thread_write_is_atomic_and_carries_revision_and_epoch(self) -> None:
        with patch("hq_ai.generate", return_value=(json.dumps({"reply": "Périmètre sain.", "tools": []}), "mock")):
            res = hq_securia.chat("état du trafic ?")
        self.assertTrue(res["ok"])
        data = json.loads(self._thread_file().read_text(encoding="utf-8"))
        self.assertEqual(len(data["messages"]), 2)
        self.assertGreaterEqual(data["revision"], 1)
        self.assertEqual(data["clear_epoch"], 0)
        self.assertFalse(self._thread_file().with_suffix(".tmp").exists())

    def test_clear_during_generation_discards_the_reply(self) -> None:
        def generate(*_args, **_kwargs):
            hq_securia.clear_thread()          # the Master pressed Effacer while the model was writing
            return json.dumps({"reply": "Trop tard, Maître.", "tools": []}), "mock"

        with patch("hq_ai.generate", side_effect=generate):
            res = hq_securia.chat("état du trafic ?")
        self.assertTrue(res["cancelled"])
        self.assertEqual(hq_securia.get_thread()["messages"], [])

    def test_a_turn_that_landed_meanwhile_is_kept(self) -> None:
        def generate(*_args, **_kwargs):
            current = hq_securia.get_thread()
            hq_securia._append_turn_if_current(
                [{"role": "user", "text": "autre question"},
                 {"role": "assistant", "text": "réponse arrivée avant"}],
                current["revision"], current["clear_epoch"])
            return json.dumps({"reply": "Voici ma réponse.", "tools": []}), "mock"

        with patch("hq_ai.generate", side_effect=generate):
            res = hq_securia.chat("état du trafic ?")
        texts = [m["text"] for m in hq_securia.get_thread()["messages"]]
        self.assertTrue(res["ok"])
        self.assertTrue(res["rebased"])
        self.assertIn("réponse arrivée avant", texts)
        self.assertIn("Voici ma réponse.", texts)

    def test_cancelled_turn_stores_nothing(self) -> None:
        hq_securia.cancel("sc-testjob")
        code, res = hq_securia.http_post("/api/securia/chat", {"message": "audit", "job": "sc-testjob"})
        self.assertEqual(code, 200)
        self.assertTrue(res["cancelled"])
        self.assertEqual(hq_securia.get_thread()["messages"], [])

    def test_destructive_tool_is_queued_and_runs_only_on_confirm(self) -> None:
        executed = []

        def fake_execute(name, args):
            executed.append((name, args))
            return {"name": name, "ok": True, "result": {"message": "quarantaine posée"}}

        replies = [
            (json.dumps({"reply": "Je la mets en quarantaine.",
                         "tools": [{"name": "block_ip", "args": {"ip": "203.0.113.9", "reason": "brute force"}}]}), "mock"),
            (json.dumps({"reply": "La carte attend ta confirmation, Maître.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies), \
             patch.object(hq_securia, "_execute_tool", side_effect=fake_execute):
            res = hq_securia.chat("bloque 203.0.113.9")
        self.assertEqual(executed, [])                      # nothing ran during the turn
        proposals = hq_securia.get_thread()["messages"][-1]["proposals"]
        self.assertEqual(proposals[0]["status"], "pending")
        self.assertEqual(proposals[0]["name"], "block_ip")

        with patch.object(hq_securia, "_execute_tool", side_effect=fake_execute):
            out = hq_securia.confirm(proposals[0]["id"])
        self.assertTrue(out["ok"])
        self.assertEqual(executed, [("block_ip", {"ip": "203.0.113.9", "reason": "brute force"})])
        stored = hq_securia.get_thread()["messages"][-1]["proposals"][0]
        self.assertEqual(stored["status"], "done")

        with self.assertRaises(hq_securia.SecuriaError) as ctx:
            hq_securia.confirm(proposals[0]["id"])
        self.assertEqual(ctx.exception.code, "already_resolved")
        self.assertEqual(len(executed), 1)                  # a double click never runs it twice

    def test_dismissed_proposal_never_runs(self) -> None:
        executed = []
        replies = [
            (json.dumps({"reply": "Je prépare la révocation.",
                         "tools": [{"name": "revoke_session", "args": {"session_id_prefix": "abcd1234"}}]}), "mock"),
            (json.dumps({"reply": "Carte prête.", "tools": []}), "mock"),
        ]
        with patch("hq_ai.generate", side_effect=replies), \
             patch.object(hq_securia, "_execute_tool", side_effect=lambda n, a: executed.append(n) or {"ok": True}):
            hq_securia.chat("révoque la session oubliée")
        prop = hq_securia.get_thread()["messages"][-1]["proposals"][0]
        hq_securia.dismiss(prop["id"])
        self.assertEqual(executed, [])
        self.assertEqual(hq_securia.get_thread()["messages"][-1]["proposals"][0]["status"], "dismissed")

    def test_loopback_is_never_blockable(self) -> None:
        res = hq_securia._execute_tool("block_ip", {"ip": "127.0.0.1"})
        self.assertFalse(res["ok"])
        self.assertIn("jamais", res["error"].lower())
        self.assertFalse(hq_securia._execute_tool("block_ip", {"ip": "pas-une-ip"})["ok"])

    def test_unreadable_thread_is_preserved(self) -> None:
        path = self._thread_file()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{broken", encoding="utf-8")
        before = path.read_bytes()
        with patch("hq_ai.generate", return_value=(json.dumps({"reply": "ok", "tools": []}), "mock")):
            with self.assertRaises(hq_securia.SecuriaError) as ctx:
                hq_securia.chat("état ?")
        self.assertEqual(ctx.exception.code, "state_unreadable")
        self.assertEqual(path.read_bytes(), before)

    def test_get_honeypot_status_tool(self) -> None:
        res = hq_securia._execute_tool("get_honeypot_status", {})
        self.assertTrue(res["ok"])
        data = res["result"]
        # The bridge installs no decoy routes and no user-agent filter, so the
        # layer reports an honest zero instead of a defence it cannot back.
        self.assertIn("decoy_routes_count", data)
        self.assertEqual(data["decoy_routes_count"], 0)
        self.assertIn("ai_scrapers_blocked_signatures", data)
        self.assertEqual(data["ai_scrapers_blocked_signatures"], 0)
        self.assertIn("malicious_scanners_blocked_signatures", data)
        self.assertEqual(data["malicious_scanners_blocked_signatures"], 0)

    def test_status_summary_healthy_vs_danger(self) -> None:
        clean = hq_securia.status_summary()
        self.assertTrue(clean["ok"])
        self.assertIn("alert_level", clean)

        import hq_security
        # Mock a honeypot event in _sec_log_tail
        with patch.object(hq_securia, "_sec_log_tail", return_value=[
            {"event": hq_security.SecurityLog.EVENT_HONEYPOT_TRIGGERED, "reason": "decoy_route:/.env", "timestamp": "2026-11-17T00:00:00Z"}
        ]):
            danger = hq_securia.status_summary()
            self.assertEqual(danger["alert_level"], "danger")
            self.assertIsNotNone(danger["proactive_alert"])
            self.assertIn("trappe activée", danger["proactive_alert"]["message"])
            self.assertGreaterEqual(danger["threat_count"], 1)


    def test_generate_security_digest_and_tool(self) -> None:
        digest = hq_securia.generate_security_digest(days=7)
        self.assertTrue(digest["ok"])
        self.assertIn("health_score", digest)
        self.assertIn("deflected_summary", digest)
        self.assertIn("quota_guard", digest)
        self.assertIn("quarantine_registry", digest)

        # Test tool invocation
        res = hq_securia._execute_tool("get_weekly_security_report", {"days": 7})
        self.assertTrue(res["ok"])
        self.assertEqual(res["name"], "get_weekly_security_report")
        self.assertIn("health_status", res["result"])


if __name__ == "__main__":
    unittest.main()
