"""Session generation must survive a restart. Disposable files and synthetic credentials only."""

from __future__ import annotations

import json
import shutil
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path

import iphone_bridge as bridge


PIN = "synthetic-session-pin"


def _http(port: int, path: str, cookie: str) -> tuple[int, bytes]:
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        conn.request("GET", path, headers={"Host": f"127.0.0.1:{port}", "Cookie": cookie})
        resp = conn.getresponse()
        return resp.status, resp.read()
    finally:
        conn.close()


class SessionReloadTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-sessions-"))
        self.path = self.tmp / "bridge_sessions.json"
        self.saved = (
            bridge.SESSIONS_PATH,
            dict(bridge._SESSIONS),
            json.loads(json.dumps(bridge.CONFIG)),
        )
        bridge.SESSIONS_PATH = self.path
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS.clear()
        bridge.CONFIG["pin"] = PIN
        bridge.CONFIG["users"] = []
        bridge.CONFIG["auth_generation"] = 1

    def tearDown(self) -> None:
        bridge.SESSIONS_PATH = self.saved[0]
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS.clear()
            bridge._SESSIONS.update(self.saved[1])
        bridge.CONFIG.clear()
        bridge.CONFIG.update(self.saved[2])
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _reload(self) -> None:
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS.clear()
        bridge.load_sessions()

    def test_issue_persist_reload_validates(self) -> None:
        token = bridge.issue_session("keeper", "admin")
        self.assertEqual(bridge._SESSIONS[token]["gen"], 1)
        self._reload()
        info = bridge.session_info(token)
        self.assertIsNotNone(info)
        assert info is not None
        self.assertEqual(info["gen"], 1)
        self.assertEqual(info["user"], "keeper")
        self.assertTrue(bridge.session_valid(token))

    def test_generation_one_survives_under_generation_one(self) -> None:
        token = bridge.issue_session("keeper", "admin")
        self._reload()
        self.assertEqual(bridge.session_info(token)["gen"], 1)
        self.assertEqual(json.loads(self.path.read_text(encoding="utf-8"))[token]["gen"], 1)

    def test_generation_mismatch_invalidates(self) -> None:
        token = bridge.issue_session("keeper", "admin")
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        stored[token]["gen"] = 2
        self.path.write_text(json.dumps(stored), encoding="utf-8")
        self._reload()
        self.assertIsNone(bridge.session_info(token))
        self.assertNotIn(token, bridge._SESSIONS)
        self.assertNotIn(token, json.loads(self.path.read_text(encoding="utf-8")))

    def test_missing_or_malformed_generation_fails_closed(self) -> None:
        future = time.time() + 600
        self.path.write_text(json.dumps({
            "missing": {"exp": future, "user": "a", "role": "admin"},
            "text": {"exp": future, "user": "a", "role": "admin", "gen": "1"},
            "flag": {"exp": future, "user": "a", "role": "admin", "gen": True},
            "decimal": {"exp": future, "user": "a", "role": "admin", "gen": 1.0},
            "legacy": future,
        }), encoding="utf-8")
        self._reload()
        self.assertEqual(bridge._SESSIONS, {})
        for name in ("missing", "text", "flag", "decimal", "legacy"):
            self.assertIsNone(bridge.session_info(name), name)
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS["numeric"] = future
        self.assertIsNone(bridge.session_info("numeric"))
        self.assertNotIn("numeric", bridge._SESSIONS)
        self.assertNotEqual(bridge._SESSIONS.get("numeric", {}).get("role"), "admin")

    def test_expired_session_stays_invalid(self) -> None:
        token = bridge.issue_session("keeper", "admin")
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        stored[token]["exp"] = time.time() - 5
        self.path.write_text(json.dumps(stored), encoding="utf-8")
        self._reload()
        self.assertIsNone(bridge.session_info(token))
        self.assertFalse(bridge.session_valid(token))

    def test_roles_are_not_escalated(self) -> None:
        upload = bridge.issue_session("phone", "upload")
        future = time.time() + 600
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        stored["blank"] = {"exp": future, "user": "nobody", "gen": 1}
        stored["operator"] = {"exp": future, "user": "op", "role": "operator", "gen": 1}
        self.path.write_text(json.dumps(stored), encoding="utf-8")
        self._reload()
        self.assertEqual(bridge.session_role(upload), "upload")
        self.assertEqual(bridge._SESSIONS[upload]["role"], "upload")
        self.assertNotIn("blank", bridge._SESSIONS)
        self.assertNotIn("operator", bridge._SESSIONS)
        self.assertEqual(bridge.session_role("operator"), "")

    def test_valid_reload_is_not_removed_by_authenticated_get(self) -> None:
        token = bridge.issue_session("keeper", "admin")
        self._reload()
        before = self.path.read_bytes()
        root = self.tmp / "root"
        root.mkdir()
        saved_root = bridge.ROOT
        saved_cc_root = bridge.cc_ext.ROOT
        bridge.ROOT = root
        bridge.bind_cc_ext()

        class Quiet(bridge.Handler):
            def log_message(self, *_args):
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            status, body = _http(port, "/api/health", f"transfert_session={token}")
            self.assertEqual(status, 200)
            payload = json.loads(body.decode("utf-8"))
            self.assertTrue(payload["ok"])
            self.assertEqual(payload["version"], "7.0")
            self.assertEqual(self.path.read_bytes(), before)
            self.assertIn(token, bridge._SESSIONS)
            self.assertEqual(bridge._SESSIONS[token]["gen"], 1)
        finally:
            httpd.shutdown()
            httpd.server_close()
            bridge.ROOT = saved_root
            if saved_cc_root is not None:
                bridge.cc_ext.bind(ROOT=saved_cc_root)
                bridge.cc_ext.load_activity()

    def test_expired_pruning_keeps_a_valid_sibling(self) -> None:
        valid = bridge.issue_session("keeper", "admin")
        self._reload()
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS["old"] = {"exp": time.time() - 30, "user": "old", "role": "admin", "gen": 1}
        info = bridge.session_info(valid)
        self.assertIsNotNone(info)
        assert info is not None
        self.assertEqual(info["gen"], 1)
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertIn(valid, saved)
        self.assertNotIn("old", saved)
        self.assertNotIn("old", bridge._SESSIONS)

    def test_roles_and_expirations_fail_closed(self) -> None:
        admin = bridge.issue_session("keeper", "admin")
        upload = bridge.issue_session("phone", "upload")
        self._reload()
        self.assertEqual(bridge.session_role(admin), "admin")
        self.assertEqual(bridge.session_role(upload), "upload")
        future = time.time() + 600
        base = {"exp": future, "user": "a", "gen": 1}
        self.path.write_text(json.dumps({
            "missing": dict(base),
            "empty": {**base, "role": ""},
            "unknown": {**base, "role": "operator"},
            "padded": {**base, "role": "admin "},
            "cased": {**base, "role": "Admin"},
            "number": {**base, "role": 1},
            "flag": {**base, "role": True},
            "text": {**base, "role": "admin", "exp": "9999999999"},
            "bool-exp": {**base, "role": "admin", "exp": True},
        }), encoding="utf-8")
        self._reload()
        for name in ("missing", "empty", "unknown", "padded", "cased", "number", "flag", "text", "bool-exp"):
            self.assertNotIn(name, bridge._SESSIONS, name)
            self.assertEqual(bridge.session_role(name), "", name)
        for label, exp in (("nan", float("nan")), ("posinf", float("inf")), ("neginf", float("-inf"))):
            self.assertIsNone(bridge._session_from_stored({"exp": exp, "user": "a", "role": "admin", "gen": 1}), label)
        huge = 10 ** 10000
        stored_huge = 10 ** 4000
        self.assertIsNone(bridge._stored_expiration(huge))
        self.assertIsNone(bridge._session_from_stored({"exp": huge, "user": "a", "role": "admin", "gen": 1}))
        self.path.write_text(json.dumps({"huge": {"exp": stored_huge, "user": "a", "role": "admin", "gen": 1}}), encoding="utf-8")
        self._reload()
        self.assertNotIn("huge", bridge._SESSIONS)
        self.assertEqual(bridge.session_role("huge"), "")
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS["huge"] = {"exp": huge, "user": "a", "role": "admin", "gen": 1}
            bridge._SESSIONS["broken"] = {"exp": huge, "user": "a", "role": "operator", "gen": "nope"}
        self.assertEqual(bridge.session_role("huge"), "")
        self.assertEqual(bridge.session_role("broken"), "")
        self.assertNotIn("huge", bridge._SESSIONS)
        self.assertNotIn("broken", bridge._SESSIONS)
        with bridge._SESSIONS_LOCK:
            bridge._SESSIONS["planted"] = {"exp": future, "user": "op", "role": "operator", "gen": 1}
        self.assertEqual(bridge.session_role("planted"), "")
        self.assertNotIn("planted", bridge._SESSIONS)

    def test_route_authorization_keeps_admin_and_upload(self) -> None:
        admin = bridge.issue_session("keeper", "admin")
        upload = bridge.issue_session("phone", "upload")
        self._reload()
        root = self.tmp / "root"
        root.mkdir()
        saved_root = bridge.ROOT
        saved_cc_root = bridge.cc_ext.ROOT
        bridge.ROOT = root
        bridge.bind_cc_ext()
        bridge.bind_hq()

        class Quiet(bridge.Handler):
            def log_message(self, *_args):
                return

        httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            self.assertEqual(_http(port, "/api/health", f"transfert_session={admin}")[0], 200)
            self.assertEqual(_http(port, "/api/automation", f"transfert_session={admin}")[0], 200)
            self.assertEqual(_http(port, "/api/automation", f"transfert_session={upload}")[0], 403)
            self.assertEqual(_http(port, "/api/automation", "transfert_session=operator")[0], 401)
            self.assertEqual(bridge.session_role(admin), "admin")
            self.assertEqual(bridge.session_role(upload), "upload")
        finally:
            httpd.shutdown()
            httpd.server_close()
            bridge.ROOT = saved_root
            if saved_cc_root is not None:
                bridge.cc_ext.bind(ROOT=saved_cc_root)
                bridge.cc_ext.load_activity()

    def test_concurrent_access_does_not_corrupt_saved_state(self) -> None:
        errors: list[BaseException] = []

        def issue() -> None:
            try:
                for i in range(25):
                    role = "upload" if i % 2 else "admin"
                    token = bridge.issue_session(f"u{i}", role)
                    bridge.session_info(token)
            except BaseException as exc:
                errors.append(exc)

        def reload() -> None:
            try:
                for _ in range(25):
                    bridge.load_sessions()
            except BaseException as exc:
                errors.append(exc)

        threads = [threading.Thread(target=issue) for _ in range(4)]
        threads += [threading.Thread(target=reload) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(10)
            self.assertFalse(thread.is_alive())
        self.assertEqual(errors, [])
        bridge._persist_sessions()
        saved = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertIsInstance(saved, dict)
        with bridge._SESSIONS_LOCK:
            live = {
                tok: dict(info)
                for tok, info in bridge._SESSIONS.items()
                if isinstance(info, dict) and float(info.get("exp") or 0) > time.time()
            }
        self.assertEqual(saved, live)
        for info in saved.values():
            self.assertIsInstance(info["gen"], int)
            self.assertNotIsInstance(info["gen"], bool)
            self.assertIn(info["role"], ("admin", "upload"))


if __name__ == "__main__":
    unittest.main()
