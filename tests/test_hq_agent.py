"""Companion registry, jobs, and local end-to-end poll.

No Windows desktop, no live Tailscale, no public listener.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlencode

import companion_ops
import hq_agent_ops as ops
import hq_agent_protocol as proto
import hq_companion
import hq_devices
import hq_events
import hq_jobs
import iphone_bridge

PIN = "424242"


def _http(port, method, path, *, body=None, headers=None, cookie=None):
    import http.client

    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=8)
    hdrs = {"Host": f"127.0.0.1:{port}"}
    if headers:
        hdrs.update(headers)
    if cookie:
        hdrs["Cookie"] = cookie
    if body is not None and "Content-Length" not in hdrs:
        hdrs["Content-Length"] = str(len(body))
    conn.request(method, path, body=body, headers=hdrs)
    resp = conn.getresponse()
    payload = resp.read()
    return resp.status, dict(resp.getheaders()), payload


class AgentCoreTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-agent-"))
        self.now = 1_700_000_000.0
        self.events = []
        hq_events.bind(self.tmp)
        hq_companion.bind(self.tmp, journal=self._journal, now=lambda: self.now)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _journal(self, kind, message, **extra):
        self.events.append((kind, message, extra))

    def _enroll(self, *, os_name="windows", support=None, name="Marco Laptop", hostname="marco-laptop", ips=None):
        token = hq_companion.create_enroll_token(label="test")["token"]
        body = {
            "token": token,
            "name": name,
            "hostname": hostname,
            "os": os_name,
            "protocol_version": 1,
            "support": support if support is not None else list(hq_devices.DEFAULT_AGENT_POLICY) + ["power_shutdown", "clipboard_read", "terminal_allowlisted"],
            "tailscale_ips": ips or ["100.9.9.9"],
        }
        return token, hq_companion.enroll(token=token, body=body, client_ip="10.1.1.1")

    def _headers(self, secret, device_id, path, body: bytes, *, nonce: str | None = None, stamp: int | None = None):
        import secrets

        nonce = nonce or secrets.token_urlsafe(18)
        stamp = int(self.now if stamp is None else stamp)
        return {
            proto.HEADER_DEVICE: device_id,
            proto.HEADER_TIME: str(stamp),
            proto.HEADER_NONCE: nonce,
            proto.HEADER_SIGNATURE: proto.sign(secret, "POST", path, stamp, nonce, body),
        }

    def test_phone_and_claims_never_grant_agent_power(self):
        phone = hq_devices.normalize(
            {
                "id": "ts:1",
                "source": "tailscale",
                "os": "iOS 17",
                "online": True,
                "capabilities": ["power_shutdown", "raw_shell"],
                "agent_capabilities": ["status"],
                "_granted": ["status", "power_shutdown", "terminal_interactive", "raw_shell"],
                "_agent_id": "ag_abcdef01",
            }
        )
        self.assertEqual(phone["access"], ["browser"])
        self.assertEqual(phone["agent_capabilities"], [])
        self.assertNotIn("agent_id", phone)
        self.assertNotIn("ssh_target", phone["capabilities"])
        self.assertNotIn("raw_shell", phone["capabilities"])
        peer = hq_devices.normalize(
            {
                "id": "ag_deadbeef",
                "source": "agent",
                "os": "windows",
                "capabilities": ["raw_shell"],
                "_granted": ["status", "raw_shell", "terminal_interactive", "power_shutdown"],
            }
        )
        self.assertEqual(peer["agent_capabilities"], ["status", "power_shutdown"])
        self.assertIn("agent", peer["access"])
        self.assertNotIn("terminal_interactive", peer["agent_capabilities"])
        self.assertNotIn("raw_shell", json.dumps(peer))

    def test_enrollment_is_one_time_and_hides_secret(self):
        token, enrolled = self._enroll()
        self.assertTrue(enrolled["device_secret"])
        self.assertNotIn("secret", json.dumps(hq_companion.list_devices()))
        with self.assertRaises(ops.AgentOpError):
            hq_companion.enroll(
                token=token,
                body={"token": token, "name": "x", "os": "windows", "protocol_version": 1, "support": ["status"]},
                client_ip="10.1.1.2",
            )
        with self.assertRaises(ops.AgentOpError):
            hq_companion.enroll(
                token="nope",
                body={"token": "nope", "name": "Phone", "os": "iPadOS", "protocol_version": 1, "support": ["status"]},
                client_ip="10.1.1.3",
            )
        listed = hq_companion.list_devices()
        self.assertEqual(len(listed), 1)
        self.assertNotIn("power_shutdown", listed[0]["granted"])
        self.assertIn("status", listed[0]["granted"])
        self.assertNotIn("terminal_interactive", listed[0]["granted"])

    def test_hmac_skew_replay_and_revoke(self):
        _token, enrolled = self._enroll()
        body = b"{}"
        headers = self._headers(enrolled["device_secret"], enrolled["device_id"], "/agent/v1/poll", body)
        code, payload = hq_companion.handle_device(method="POST", path="/agent/v1/poll", headers=headers, body=body)
        self.assertEqual(code, 200)
        self.assertIsNone(payload["job"])
        code, _payload = hq_companion.handle_device(method="POST", path="/agent/v1/poll", headers=headers, body=body)
        self.assertEqual(code, 401)
        tampered = self._headers(enrolled["device_secret"], enrolled["device_id"], "/agent/v1/poll", b"{}")
        code, _payload = hq_companion.handle_device(method="POST", path="/agent/v1/poll", headers=tampered, body=b'{"x":1}')
        self.assertEqual(code, 401)
        late = self._headers(
            enrolled["device_secret"],
            enrolled["device_id"],
            "/agent/v1/poll",
            body,
            stamp=int(self.now) + 120,
        )
        code, _payload = hq_companion.handle_device(method="POST", path="/agent/v1/poll", headers=late, body=body)
        self.assertEqual(code, 401)
        self.assertFalse(proto.signatures_equal("short", "other"))
        self.assertTrue(proto.signatures_equal("ab" * 32, "ab" * 32))
        hq_companion.revoke(enrolled["device_id"])
        fresh = self._headers(enrolled["device_secret"], enrolled["device_id"], "/agent/v1/poll", body)
        code, _payload = hq_companion.handle_device(method="POST", path="/agent/v1/poll", headers=fresh, body=body)
        self.assertEqual(code, 401)

    def test_planner_cannot_self_approve_and_confirm_is_ignored(self):
        _token, enrolled = self._enroll()
        device_id = enrolled["device_id"]
        hq_companion.set_policy(device_id, list(hq_devices.DEFAULT_AGENT_POLICY) + ["power_shutdown", "clipboard_read"])
        granted = hq_companion.granted_for(device_id)
        read_job = hq_jobs.create_job(
            device_id=device_id,
            op="system.status",
            args={},
            origin="planner",
            granted=granted,
            confirm=True,
        )
        self.assertEqual(read_job["state"], "queued")
        sensitive = hq_jobs.create_job(
            device_id=device_id,
            op="clipboard.read",
            args={},
            origin="planner",
            granted=granted,
            confirm=True,
        )
        self.assertEqual(sensitive["state"], "awaiting_approval")
        self.assertFalse(sensitive["approved"])
        destructive = hq_jobs.create_job(
            device_id=device_id,
            op="power.shutdown",
            args={},
            origin="planner",
            granted=granted,
            ttl_sec=99999,
            confirm="yes",
        )
        self.assertEqual(destructive["state"], "awaiting_approval")
        self.assertLessEqual(destructive["expires_at"] - destructive["created_at"], 600)
        with self.assertRaises(PermissionError):
            hq_jobs.approve(destructive["id"], actor="planner")
        taken = hq_jobs.take_next(device_id)
        self.assertEqual(taken["op"], "system.status")
        self.assertNotEqual(taken["id"], destructive["id"])
        self.assertTrue(taken["approved"])
        approved = hq_jobs.approve(destructive["id"], actor="human")
        self.assertEqual(approved["state"], "queued")
        code, payload = hq_companion.admin_post(
            {
                "action": "job",
                "device_id": device_id,
                "op": "power.shutdown",
                "origin": "planner",
                "confirm": True,
                "args": {},
            }
        )
        self.assertEqual(code, 200)
        self.assertEqual(payload["job"]["origin"], "human")
        self.assertEqual(payload["job"]["state"], "awaiting_approval")

    def test_offline_queue_expires_and_corrupt_file_is_kept(self):
        _token, enrolled = self._enroll()
        job = hq_jobs.create_job(
            device_id=enrolled["device_id"],
            op="system.status",
            args={},
            origin="human",
            granted=hq_companion.granted_for(enrolled["device_id"]),
            ttl_sec=30,
        )
        self.assertEqual(job["state"], "queued")
        self.now += 31
        listed = hq_jobs.list_jobs(device_id=enrolled["device_id"])
        self.assertEqual(listed["jobs"][0]["state"], "expired")
        path = self.tmp / "hq_agent_jobs.json"
        original = "{nope"
        path.write_text(original, encoding="utf-8")
        hq_jobs.bind(self.tmp, now=lambda: self.now)
        self.assertTrue(hq_jobs.malformed())
        with self.assertRaises(RuntimeError):
            hq_jobs.create_job(device_id=enrolled["device_id"], op="system.status", args={}, origin="human")
        self.assertEqual(path.read_text(encoding="utf-8"), original)
        agents = self.tmp / "hq_agents.json"
        agents.write_text("{", encoding="utf-8")
        hq_companion.bind(self.tmp, now=lambda: self.now)
        self.assertTrue(hq_companion.malformed())
        with self.assertRaises(RuntimeError):
            hq_companion.create_enroll_token()
        self.assertEqual(agents.read_text(encoding="utf-8"), "{")

    def test_phone_is_not_merged_into_an_agent(self):
        _token, enrolled = self._enroll(ips=["100.9.9.9"], hostname="marco-laptop")
        roster = hq_companion.overlay_roster(
            [
                {
                    "id": "ts:phone",
                    "name": "marco-laptop",
                    "source": "tailscale",
                    "os": "iOS",
                    "online": True,
                    "ip": "100.9.9.9",
                }
            ]
        )
        phone = hq_devices.present(roster[0])
        self.assertEqual(phone["access"], ["browser"])
        self.assertNotIn("agent_id", phone)
        self.assertTrue(any(row.get("id") == enrolled["device_id"] for row in roster))

    def test_filesystem_terminal_and_power_guards(self):
        work = self.tmp / "work"
        work.mkdir()
        (work / "note.pdf").write_bytes(b"%PDF-1.4 marker-note")
        outside = self.tmp / "secret.txt"
        outside.write_text("secret", encoding="utf-8")
        host = companion_ops.RealHost(
            {
                "workspaces": {"default": str(work)},
                "terminal_allowlist": [{"id": "hi", "argv": [sys.executable, "-c", "print('hq-ok')"]}],
                "destructive_power_enabled": False,
            }
        )
        with self.assertRaises(ops.AgentOpError):
            ops.validate_args("fs.read", {"path": "../secret.txt"})
        with self.assertRaises(ops.AgentOpError):
            ops.validate_args("terminal.run_allowlisted", {"id": "hi", "command": "calc.exe"})
        denied = companion_ops.execute(
            {"op": "fs.read", "approved": True, "args": {"path": "../secret.txt"}},
            host,
            granted=["files_read"],
        )
        self.assertFalse(denied["ok"])
        staged = companion_ops.execute(
            {"op": "fs.stage", "approved": True, "args": {"path": "note.pdf"}},
            host,
            granted=["files_read"],
        )
        self.assertTrue(staged["ok"])
        self.assertEqual(staged["artifact_bytes"], b"%PDF-1.4 marker-note")
        ran = companion_ops.execute(
            {"op": "terminal.run_allowlisted", "approved": True, "args": {"id": "hi"}, "timeout_sec": 10},
            host,
            granted=["terminal_allowlisted"],
        )
        self.assertTrue(ran["ok"], ran)
        self.assertIn("hq-ok", ran["output"])
        smuggled = companion_ops.execute(
            {"op": "terminal.run_allowlisted", "approved": True, "args": {"id": "hi", "shell": "bash"}},
            host,
            granted=["terminal_allowlisted"],
        )
        self.assertFalse(smuggled["ok"])
        unapproved = companion_ops.execute(
            {"op": "power.shutdown", "approved": False, "args": {}},
            host,
            granted=["power_shutdown"],
        )
        self.assertFalse(unapproved["ok"])
        blocked = companion_ops.RealHost({"destructive_power_enabled": False, "workspaces": {"default": str(work)}})
        with self.assertRaises(ops.AgentOpError):
            blocked.power("shutdown", approved=True)
        with self.assertRaises(ops.AgentOpError):
            host.kill(1, "init")
        self.assertGreaterEqual(proto.next_delay(poll_sec=1, idle_sec=15, idle_streak=0, error_streak=0), 2)
        self.assertEqual(proto.next_delay(poll_sec=3, idle_sec=15, idle_streak=30, error_streak=0), 15)
        self.assertLessEqual(proto.next_delay(poll_sec=3, idle_sec=15, idle_streak=0, error_streak=8), 60)
        with self.assertRaises(ValueError):
            proto.validate_controller_url("http://100.1.1.1/", dev=True)
        with self.assertRaises(ValueError):
            proto.validate_controller_url("http://127.0.0.1:8765/", dev=False)

    def test_hqctl_planner_waits_and_cannot_approve(self):
        _token, enrolled = self._enroll()
        hq_companion.set_policy(
            enrolled["device_id"],
            list(hq_devices.DEFAULT_AGENT_POLICY) + ["power_shutdown"],
        )
        proc = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "hqctl.py"),
                "--root",
                str(self.tmp),
                "--json",
                "run",
                "--device",
                enrolled["device_id"],
                "--op",
                "power.shutdown",
                "--confirm",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        payload = json.loads(proc.stdout)
        self.assertEqual(payload["job"]["state"], "awaiting_approval")
        self.assertEqual(payload["job"]["origin"], "planner")
        denied = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "hqctl.py"),
                "--root",
                str(self.tmp),
                "--json",
                "approve",
                payload["job"]["id"],
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(denied.returncode, 1)
        self.assertIn("approuver", denied.stdout)
        allowed = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).resolve().parents[1] / "hqctl.py"),
                "--root",
                str(self.tmp),
                "--json",
                "approve",
                payload["job"]["id"],
                "--origin",
                "human",
            ],
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(allowed.returncode, 0, allowed.stdout)
        self.assertEqual(json.loads(allowed.stdout)["job"]["state"], "queued")

    def test_ui_mentions_agent_center_and_upload_role_is_excluded(self):
        page = iphone_bridge.render_app().decode("utf-8")
        self.assertIn("Centre agents", page)
        self.assertIn("/assets/hq-agent.js", page)
        self.assertNotIn("/api/agent", iphone_bridge.UPLOAD_POST_EXACT)
        self.assertNotIn("/api/agent", iphone_bridge.UPLOAD_GET_EXACT)


class AgentHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._config = json.loads(json.dumps(iphone_bridge.CONFIG))
        iphone_bridge.CONFIG["pin"] = PIN
        iphone_bridge.CONFIG["users"] = []
        iphone_bridge.CONFIG["discord_webhook_url"] = ""
        iphone_bridge.bind_cc_ext()
        iphone_bridge.bind_hq()
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), iphone_bridge.Handler)
        cls.port = cls.httpd.server_address[1]
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        status, headers, _body = _http(
            cls.port,
            "POST",
            "/login",
            body=urlencode({"pin": PIN}).encode(),
            headers={"Origin": f"http://127.0.0.1:{cls.port}", "Content-Type": "application/x-www-form-urlencoded"},
        )
        if status != 303:
            raise AssertionError(f"login failed {status}")
        raw = headers.get("Set-Cookie") or headers.get("set-cookie") or ""
        cls.admin = raw.split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        iphone_bridge.CONFIG.clear()
        iphone_bridge.CONFIG.update(cls._config)
        hq_companion.bind(iphone_bridge.ROOT)
        hq_events.bind(iphone_bridge.ROOT)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-agent-http-"))
        self.work = self.tmp / "work"
        self.work.mkdir()
        hq_events.bind(self.tmp)
        hq_companion.bind(self.tmp, now=lambda: __import__("time").time())

    def tearDown(self):
        hq_companion.bind(iphone_bridge.ROOT)
        hq_events.bind(iphone_bridge.ROOT)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _admin(self, payload):
        return _http(
            self.port,
            "POST",
            "/api/agent",
            body=json.dumps(payload).encode(),
            headers={"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"},
            cookie=self.admin,
        )

    def test_local_dev_roundtrip_stages_file_without_embedding_bytes(self):
        status, _headers, body = _http(self.port, "GET", "/agent/v1/poll")
        self.assertEqual(status, 405)
        status, _headers, body = _http(self.port, "POST", "/agent/v1/poll", body=b"{}")
        self.assertEqual(status, 401)

        status, _headers, body = self._admin({"action": "enroll-token", "label": "marco"})
        self.assertEqual(status, 200, body)
        token = json.loads(body)["token"]
        enroll_body = json.dumps(
            {
                "token": token,
                "name": "Marco Laptop",
                "hostname": "marco-laptop",
                "os": "linux",
                "protocol_version": 1,
                "support": list(hq_devices.DEFAULT_AGENT_POLICY),
                "tailscale_ips": [],
            }
        ).encode()
        status, _headers, body = _http(self.port, "POST", "/agent/v1/enroll", body=enroll_body, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 200, body)
        enrolled = json.loads(body)
        self.assertTrue(enrolled["device_secret"])
        status, _headers, body = _http(self.port, "POST", "/agent/v1/enroll", body=enroll_body, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)

        ios = json.dumps(
            {"token": "autre", "name": "iPhone", "os": "iOS", "protocol_version": 1, "support": ["status"]}
        ).encode()
        # A fresh token is required to reach the OS check; reuse path already consumed.
        status, _headers, body = self._admin({"action": "enroll-token"})
        ios_token = json.loads(body)["token"]
        ios = json.dumps(
            {"token": ios_token, "name": "iPhone", "os": "iOS", "protocol_version": 1, "support": ["status"]}
        ).encode()
        status, _headers, body = _http(self.port, "POST", "/agent/v1/enroll", body=ios, headers={"Content-Type": "application/json"})
        self.assertEqual(status, 400)
        self.assertIn("iOS", body.decode())

        marker = b"%PDF-1.4 hq-marker-unique"
        (self.work / "note.pdf").write_bytes(marker)
        status, _headers, body = self._admin(
            {
                "action": "job",
                "device_id": enrolled["device_id"],
                "op": "fs.stage",
                "args": {"path": "note.pdf"},
                "confirm": True,
                "origin": "planner",
            }
        )
        self.assertEqual(status, 200, body)
        self.assertEqual(json.loads(body)["job"]["state"], "queued")
        self.assertEqual(json.loads(body)["job"]["origin"], "human")

        import companion_agent

        outcome = companion_agent.run_once(
            {
                "controller_url": f"http://127.0.0.1:{self.port}",
                "device_id": enrolled["device_id"],
                "device_secret": enrolled["device_secret"],
                "dev": True,
                "workspaces": {"default": str(self.work)},
                "poll_sec": 3,
                "idle_poll_sec": 15,
            }
        )
        self.assertTrue(outcome["ok"], outcome)
        stored = json.loads((self.tmp / "hq_agent_jobs.json").read_text(encoding="utf-8"))
        blob = json.dumps(stored)
        self.assertNotIn("hq-marker-unique", blob)
        self.assertNotIn("base64", blob)
        artifact = stored["jobs"][0].get("artifact") or {}
        self.assertTrue(str(artifact.get("rel") or "").startswith("Inbox/AgentArtifacts/"))
        file_bytes = (self.tmp / artifact["rel"]).read_bytes()
        self.assertEqual(file_bytes, marker)

        status, _headers, body = self._admin({"action": "import", "rel": artifact["rel"], "dest": "Uni"})
        self.assertEqual(status, 200, body)
        rel = json.loads(body)["rel"]
        self.assertTrue(rel.startswith("Uni/"))
        self.assertEqual((self.tmp / rel).read_bytes(), marker)

        status, _headers, body = _http(self.port, "GET", "/api/agent", cookie=self.admin)
        self.assertEqual(status, 200)
        self.assertNotIn(enrolled["device_secret"], body.decode())
        self.assertNotIn("device_secret", body.decode())

        users = [
            {"name": "admin", "pin": PIN, "role": "admin"},
            {"name": "phone", "pin": "111111", "role": "upload"},
        ]
        iphone_bridge.CONFIG["users"] = users
        try:
            status, headers, _body = _http(
                self.port,
                "POST",
                "/login",
                body=urlencode({"pin": "111111"}).encode(),
                headers={"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/x-www-form-urlencoded"},
            )
            self.assertEqual(status, 303, _body)
            phone = (headers.get("Set-Cookie") or headers.get("set-cookie") or "").split(";", 1)[0]
            status, _headers, body = _http(
                self.port,
                "POST",
                "/api/agent",
                body=b'{"action":"enroll-token"}',
                headers={"Origin": f"http://127.0.0.1:{self.port}", "Content-Type": "application/json"},
                cookie=phone,
            )
            self.assertEqual(status, 403)
        finally:
            iphone_bridge.CONFIG["users"] = []
            iphone_bridge.CONFIG["pin"] = PIN
