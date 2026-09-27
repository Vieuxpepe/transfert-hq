"""Companion registry, jobs, and local end-to-end poll.

No Windows desktop, no live Tailscale, no public listener.
"""

from __future__ import annotations

import json
import os
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
import hq_planner
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
    status, headers = resp.status, dict(resp.getheaders())
    conn.close()
    return status, headers, payload


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

    def test_reported_identity_does_not_auto_link(self):
        _token, enrolled = self._enroll(ips=["100.9.9.9"], hostname="marco-laptop")
        peer = {
            "id": "ts:pc",
            "name": "marco-laptop",
            "source": "tailscale",
            "os": "windows",
            "online": True,
            "ip": "100.9.9.9",
        }
        roster = hq_companion.overlay_roster([peer])
        ids = [row.get("id") for row in roster]
        self.assertIn("ts:pc", ids)
        self.assertIn(enrolled["device_id"], ids)
        bare = next(row for row in roster if row.get("id") == "ts:pc")
        self.assertNotIn("_agent_id", bare)
        code, payload = hq_companion.admin_post({"action": "link", "device_id": enrolled["device_id"], "peer_id": "ts:pc"})
        self.assertEqual(code, 200, payload)
        linked = hq_companion.overlay_roster([dict(peer)])
        self.assertEqual(len(linked), 1)
        self.assertEqual(linked[0].get("_agent_id"), enrolled["device_id"])
        phone_row = {
            "id": "ts:pc",
            "name": "marco-laptop",
            "source": "tailscale",
            "os": "iOS",
            "online": True,
            "ip": "100.9.9.9",
        }
        phone = hq_companion.overlay_roster([phone_row])
        presented = hq_devices.present(phone[0])
        self.assertEqual(presented["access"], ["browser"])
        self.assertNotIn("agent_id", presented)
        self.assertTrue(any(row.get("id") == enrolled["device_id"] for row in phone))

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

    def test_public_port_does_not_serve_planner_routes(self):
        for method, path in (
            ("GET", "/local-agent/v1/devices"),
            ("POST", "/local-agent/v1/jobs"),
            ("GET", "/local-agent/v1/jobs"),
        ):
            status, _headers, body = _http(
                self.port,
                method,
                path,
                body=b"{}" if method == "POST" else None,
                headers={"X-Forwarded-For": "100.1.1.1", "Authorization": "Bearer " + ("ab" * 32)},
                cookie=self.admin,
            )
            self.assertEqual(status, 404, body)
            self.assertNotIn(b"device_secret", body)


class SecurityHardeningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-harden-"))
        self.now = 1_700_000_000.0
        hq_events.bind(self.tmp)
        hq_companion.bind(self.tmp, now=lambda: self.now, reserve_bytes=lambda: 0, disk_free=lambda _path: {"free": 10**15})

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _enroll(self, **kwargs):
        token = hq_companion.create_enroll_token(label="test")["token"]
        body = {
            "token": token,
            "name": kwargs.get("name", "Marco Laptop"),
            "hostname": kwargs.get("hostname", "marco-laptop"),
            "os": kwargs.get("os_name", "windows"),
            "protocol_version": 1,
            "support": kwargs.get("support", list(hq_devices.DEFAULT_AGENT_POLICY) + ["power_shutdown"]),
            "tailscale_ips": kwargs.get("ips", ["100.9.9.9"]),
        }
        return hq_companion.enroll(token=token, body=body, client_ip="10.1.1.1")

    def _headers(self, secret, device_id, path, body: bytes):
        import secrets

        nonce = secrets.token_urlsafe(18)
        stamp = int(self.now)
        return {
            proto.HEADER_DEVICE: device_id,
            proto.HEADER_TIME: str(stamp),
            proto.HEADER_NONCE: nonce,
            proto.HEADER_SIGNATURE: proto.sign(secret, "POST", path, stamp, nonce, body),
        }

    def _lease(self, device_id, op, args=None, origin="human"):
        job = hq_jobs.create_job(
            device_id=device_id,
            op=op,
            args=args or {},
            origin=origin,
            granted=hq_companion.granted_for(device_id),
        )
        if job["state"] == "awaiting_approval":
            job = hq_jobs.approve(job["id"], actor="human")
        leased = hq_jobs.take_next(device_id)
        self.assertIsNotNone(leased)
        self.assertEqual(leased["id"], job["id"])
        self.assertEqual(leased["state"], "leased")
        self.assertNotIn("dispatch_token", hq_jobs.get_job(job["id"]))
        return leased

    def _artifact(self, enrolled, job_id, token, body=b"%PDF-1.4 x", name="note.pdf"):
        headers = self._headers(enrolled["device_secret"], enrolled["device_id"], "/agent/v1/artifact", body)
        headers[proto.HEADER_JOB] = job_id
        headers[proto.HEADER_ARTIFACT_NAME] = name
        headers[proto.HEADER_DISPATCH] = token
        return hq_companion.handle_device(method="POST", path="/agent/v1/artifact", headers=headers, body=body)

    def test_hqctl_is_planner_client_and_cannot_approve(self):
        source = (Path(__file__).resolve().parents[1] / "hqctl.py").read_text(encoding="utf-8")
        self.assertNotIn("import hq_companion", source)
        self.assertNotIn("import hq_jobs", source)
        self.assertNotIn("enroll-token", source)
        self.assertNotIn("--origin", source)
        support = list(hq_devices.DEFAULT_AGENT_POLICY) + ["power_shutdown", "clipboard_read"]
        enrolled = self._enroll(support=support)
        hq_companion.set_policy(enrolled["device_id"], support)
        httpd = hq_planner.start(self.tmp, port=0)
        try:
            self.assertEqual(httpd.server_address[0], "127.0.0.1")
            port = httpd.server_address[1]
            token = json.loads((self.tmp / "hq_planner.json").read_text(encoding="utf-8"))["token"]
            mode = (self.tmp / "hq_planner.json").stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)
            env = os.environ.copy()
            env.pop("HQ_PLANNER_TOKEN", None)
            cli = str(Path(__file__).resolve().parents[1] / "hqctl.py")
            base = [sys.executable, cli, "--url", f"http://127.0.0.1:{port}", "--token-file", str(self.tmp / "hq_planner.json"), "--json"]
            proc = subprocess.run(base + ["run", "--device", enrolled["device_id"], "--op", "power.shutdown"], capture_output=True, text=True, check=False, env=env)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            payload = json.loads(proc.stdout)
            self.assertEqual(payload["job"]["state"], "awaiting_approval")
            self.assertEqual(payload["job"]["origin"], "planner")
            self.assertNotIn("dispatch_token", proc.stdout)
            self.assertNotIn(enrolled["device_secret"], proc.stdout)
            denied = subprocess.run(base + ["approve", payload["job"]["id"]], capture_output=True, text=True, check=False, env=env)
            self.assertNotEqual(denied.returncode, 0)
            spoof = subprocess.run(
                base + ["run", "--device", enrolled["device_id"], "--op", "system.status", "--origin", "human"],
                capture_output=True,
                text=True,
                check=False,
                env=env,
            )
            self.assertNotEqual(spoof.returncode, 0)
            status, _headers, body = _http(
                port,
                "POST",
                "/local-agent/v1/jobs",
                body=json.dumps({"device_id": enrolled["device_id"], "op": "system.status", "origin": "human", "confirm": True}).encode(),
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
            self.assertEqual(status, 400, body)
            self.assertIn("origine", body.decode())
            status, _headers, body = _http(
                port,
                "GET",
                "/local-agent/v1/devices",
                headers={"Authorization": "Bearer " + ("ab" * 32), "X-Forwarded-For": "8.8.8.8"},
            )
            self.assertEqual(status, 404, body)
            status, _headers, body = _http(port, "GET", "/local-agent/v1/devices", headers={"Authorization": "Bearer nope"})
            self.assertEqual(status, 401, body)
            status, _headers, body = _http(port, "GET", "/local-agent/v1/devices", headers={"Authorization": f"Bearer {token}"})
            self.assertEqual(status, 200, body)
            self.assertNotIn(enrolled["device_secret"], body.decode())
            self.assertNotIn("device_secret", body.decode())
            code, approved = hq_companion.admin_post({"action": "approve", "id": payload["job"]["id"]})
            self.assertEqual(code, 200, approved)
            self.assertEqual(approved["job"]["state"], "queued")
            self.assertTrue(approved["job"]["approved"])
            human = hq_jobs.create_job(
                device_id=enrolled["device_id"],
                op="power.lock",
                args={},
                origin="human",
                granted=hq_companion.granted_for(enrolled["device_id"]),
            )
            status, _headers, body = _http(
                port,
                "POST",
                f"/local-agent/v1/jobs/{human['id']}/cancel",
                body=b"{}",
                headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
            )
            self.assertEqual(status, 403, body)
            self.assertEqual(hq_jobs.get_job(human["id"])["state"], "queued")
            waiting = hq_jobs.create_job(
                device_id=enrolled["device_id"],
                op="clipboard.read",
                args={},
                origin="planner",
                granted=hq_companion.granted_for(enrolled["device_id"]),
            )
            self.assertEqual(waiting["state"], "awaiting_approval")
            cancelled = subprocess.run(base + ["cancel", "--id", waiting["id"]], capture_output=True, text=True, check=False, env=env)
            self.assertEqual(cancelled.returncode, 0, cancelled.stderr)
            self.assertEqual(json.loads(cancelled.stdout)["job"]["state"], "cancelled")
            self.assertFalse(hq_planner.direct_loopback("10.1.1.1", lambda _name: None))
            self.assertFalse(hq_planner.direct_loopback("127.0.0.1", lambda name: "x" if name == "X-Forwarded-Proto" else None))
            self.assertTrue(hq_planner.direct_loopback("127.0.0.1", lambda _name: None))
        finally:
            httpd.shutdown()
            httpd.server_close()

    def test_corrupt_planner_token_is_kept(self):
        path = self.tmp / "hq_planner.json"
        path.write_text("{", encoding="utf-8")
        with self.assertRaises(RuntimeError):
            hq_planner.ensure_token(self.tmp)
        self.assertEqual(path.read_text(encoding="utf-8"), "{")

    def test_artifact_is_authorized_before_any_write(self):
        enrolled = self._enroll()
        device_id = enrolled["device_id"]
        code, payload = self._artifact(enrolled, "job_" + "ab" * 8, "cd" * 16)
        self.assertEqual(code, 400, payload)
        self.assertFalse((self.tmp / "Inbox").exists())
        other = self._enroll(name="Other", hostname="other-pc", ips=["100.8.8.8"])
        leased = self._lease(device_id, "fs.stage", {"path": "note.pdf"})
        code, payload = self._artifact(other, leased["id"], leased["dispatch_token"])
        self.assertEqual(code, 400, payload)
        self.assertFalse((self.tmp / "Inbox").exists())
        code, payload = self._artifact(enrolled, leased["id"], leased["dispatch_token"])
        self.assertNotEqual(code, 200)
        self.assertFalse((self.tmp / "Inbox").exists())
        started = hq_jobs.acknowledge_start(device_id, leased["id"], leased["dispatch_token"])
        self.assertEqual(started["state"], "running")
        status = self._lease(device_id, "system.status")
        hq_jobs.acknowledge_start(device_id, status["id"], status["dispatch_token"])
        code, payload = self._artifact(enrolled, status["id"], status["dispatch_token"])
        self.assertEqual(code, 400, payload)
        self.assertFalse((self.tmp / "Inbox" / "AgentArtifacts" / device_id / status["id"]).exists())
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.authorize_artifact(device_id, leased["id"], "note.pdf", proto.ARTIFACT_MAX + 1, leased["dispatch_token"])
        hq_jobs.complete(device_id, status["id"], ok=True, summary="ok", dispatch_token=status["dispatch_token"])
        code, payload = self._artifact(enrolled, status["id"], status["dispatch_token"])
        self.assertEqual(code, 400, payload)
        cancelled = self._lease(device_id, "system.telemetry")
        hq_jobs.acknowledge_start(device_id, cancelled["id"], cancelled["dispatch_token"])
        hq_jobs.cancel(cancelled["id"], actor="human")
        code, payload = self._artifact(enrolled, cancelled["id"], cancelled["dispatch_token"])
        self.assertEqual(code, 400, payload)
        self.assertFalse((self.tmp / "Inbox").exists())
        hq_companion.bind(self.tmp, now=lambda: self.now, disk_free=lambda _path: {"free": 50}, reserve_bytes=lambda: 2 * 1024**3)
        code, payload = self._artifact(enrolled, leased["id"], leased["dispatch_token"])
        self.assertEqual(code, 400, payload)
        self.assertFalse((self.tmp / "Inbox").exists())
        hq_companion.bind(self.tmp, now=lambda: self.now, disk_free=lambda _path: {"free": 10**15}, reserve_bytes=lambda: 0)
        real = hq_jobs.attach_artifact

        def boom(*_args, **_kwargs):
            raise RuntimeError("meta")

        hq_jobs.attach_artifact = boom
        try:
            code, payload = self._artifact(enrolled, leased["id"], leased["dispatch_token"])
        finally:
            hq_jobs.attach_artifact = real
        self.assertEqual(code, 409, payload)
        inbox = self.tmp / "Inbox"
        leftovers = [path for path in inbox.rglob("*") if path.is_file()] if inbox.exists() else []
        self.assertEqual(leftovers, [])
        code, payload = self._artifact(enrolled, leased["id"], leased["dispatch_token"])
        self.assertEqual(code, 200, payload)
        rel = payload["artifact"]["rel"]
        self.assertEqual((self.tmp / rel).read_bytes(), b"%PDF-1.4 x")
        stored = json.loads((self.tmp / "hq_agent_jobs.json").read_text(encoding="utf-8"))
        self.assertNotIn("%PDF-1.4 x", json.dumps(stored))
        producers = sorted(name for name, spec in ops.OPS.items() if spec.produces_artifact)
        self.assertEqual(producers, ["fs.stage", "screenshot.capture"])

    def test_lease_start_and_no_blind_retry(self):
        enrolled = self._enroll()
        device_id = enrolled["device_id"]
        hq_companion.set_policy(device_id, list(hq_devices.DEFAULT_AGENT_POLICY) + ["power_shutdown", "clipboard_read"])
        granted = hq_companion.granted_for(device_id)
        read = hq_jobs.create_job(device_id=device_id, op="system.status", args={}, origin="planner", granted=granted)
        for expected in (1, 2):
            leased = hq_jobs.take_next(device_id)
            self.assertEqual(leased["attempts"], expected)
            with self.assertRaises(ops.AgentOpError):
                hq_jobs.acknowledge_start(device_id, leased["id"], "aa" * 16)
            self.assertEqual(hq_jobs.get_job(read["id"])["state"], "leased")
            with self.assertRaises(ops.AgentOpError):
                hq_jobs.complete(device_id, leased["id"], ok=True, dispatch_token=leased["dispatch_token"])
            self.now += hq_jobs.LEASE_SEC + 1
            self.assertEqual(hq_jobs.list_jobs(device_id=device_id, state="queued")["total"], 1)
        leased = hq_jobs.take_next(device_id)
        self.assertEqual(leased["attempts"], 3)
        self.now += hq_jobs.LEASE_SEC + 1
        hq_jobs.sweep()
        settled = hq_jobs.get_job(read["id"])
        self.assertEqual(settled["state"], "uncertain")
        self.assertEqual(settled["attempts"], 3)
        self.assertIsNone(hq_jobs.take_next(device_id))
        destructive = hq_jobs.create_job(device_id=device_id, op="power.shutdown", args={}, origin="human", granted=granted)
        destructive = hq_jobs.approve(destructive["id"], actor="human")
        leased = hq_jobs.take_next(device_id)
        self.assertEqual(leased["op"], "power.shutdown")
        self.now += hq_jobs.LEASE_SEC + 1
        hq_jobs.sweep()
        self.assertEqual(hq_jobs.get_job(destructive["id"])["state"], "uncertain")
        self.assertIsNone(hq_jobs.take_next(device_id))
        safe = hq_jobs.create_job(device_id=device_id, op="power.lock", args={}, origin="human", granted=granted)
        leased = hq_jobs.take_next(device_id)
        self.now += hq_jobs.LEASE_SEC + 1
        hq_jobs.sweep()
        self.assertEqual(hq_jobs.get_job(safe["id"])["state"], "uncertain")
        fresh = hq_jobs.create_job(device_id=device_id, op="system.status", args={}, origin="human", granted=granted)
        leased = hq_jobs.take_next(device_id)
        self.assertEqual(leased["id"], fresh["id"])
        code, payload = hq_companion.handle_device(
            method="POST",
            path="/agent/v1/start",
            headers=self._headers(enrolled["device_secret"], device_id, "/agent/v1/start", json.dumps({"id": leased["id"], "dispatch_token": "nope"}).encode()),
            body=json.dumps({"id": leased["id"], "dispatch_token": "nope"}).encode(),
        )
        self.assertEqual(code, 400, payload)
        body = json.dumps({"id": leased["id"], "dispatch_token": leased["dispatch_token"]}).encode()
        code, payload = hq_companion.handle_device(
            method="POST",
            path="/agent/v1/start",
            headers=self._headers(enrolled["device_secret"], device_id, "/agent/v1/start", body),
            body=body,
        )
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload["job"]["state"], "running")
        result = json.dumps({"id": leased["id"], "ok": True, "summary": "ok", "dispatch_token": "ffff"}).encode()
        code, payload = hq_companion.handle_device(
            method="POST",
            path="/agent/v1/result",
            headers=self._headers(enrolled["device_secret"], device_id, "/agent/v1/result", result),
            body=result,
        )
        self.assertEqual(code, 400, payload)
        result = json.dumps({"id": leased["id"], "ok": True, "summary": "ok", "dispatch_token": leased["dispatch_token"]}).encode()
        code, payload = hq_companion.handle_device(
            method="POST",
            path="/agent/v1/result",
            headers=self._headers(enrolled["device_secret"], device_id, "/agent/v1/result", result),
            body=result,
        )
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload["job"]["state"], "succeeded")

    def test_windows_scripts_document_acl_task_and_uninstall(self):
        root = Path(__file__).resolve().parents[1]
        install = (root / "install_companion.ps1").read_text(encoding="utf-8")
        task = install.split("New-ScheduledTaskAction", 1)[1]
        self.assertIn("icacls", install)
        self.assertIn("/inheritance:r", install)
        self.assertIn("SYSTEM:(OI)(CI)F", install)
        self.assertIn("Administrators:(OI)(CI)F", install)
        self.assertIn("(OI)(CI)M", install)
        self.assertIn("Register-ScheduledTask", install)
        self.assertIn("-AtLogon", install)
        self.assertIn("-WorkingDirectory $Dest", task)
        self.assertIn("--config", task)
        self.assertIn("-Hidden:$false", install)
        self.assertNotIn("device_secret", task)
        uninstall = (root / "uninstall_companion.ps1").read_text(encoding="utf-8")
        self.assertIn("Unregister-ScheduledTask", uninstall)
        self.assertIn("if ($DeleteData)", uninstall)
        self.assertGreater(uninstall.index("Remove-Item"), uninstall.index("if ($DeleteData)"))
        acl = (root / "install_hq_state_acl.ps1").read_text(encoding="utf-8")
        self.assertIn("ControllerIdentity", acl)
        self.assertIn("PlannerIdentity", acl)
        self.assertIn("hq_agents.json", acl)
        self.assertIn("hq_agent_jobs.json", acl)
        self.assertIn("hq_planner.json", acl)
        self.assertNotIn("/deny", acl)
        self.assertIn("SetAccessRuleProtection", acl)
        self.assertIn("FullControl", acl)
        self.assertIn("Modify", acl)
        self.assertIn("PlannerRead = $false", acl)
        self.assertIn("PlannerRead = $true", acl)
        self.assertLess(acl.index("PlannerRead = $false"), acl.index("PlannerRead = $true"))
        planner_grant = acl.split("if ($file.PlannerRead)", 1)[1]
        self.assertIn('"Read"', planner_grant)
        self.assertNotIn("Modify", planner_grant.split("Set-Acl", 1)[0])
        self.assertIn("identiques", acl)
        self.assertIn("Administrateurs", acl)
        self.assertNotIn("device_secret", acl)
        self.assertNotIn("device_secret", task)
        ctl = (root / "hqctl.py").read_text(encoding="utf-8")
        self.assertIn('Path(args.root) / "hq_planner.json"', ctl)
        self.assertNotIn("device_secret", ctl)
        auth = (root / "hq_companion.py").read_text(encoding="utf-8")
        self.assertIn("process-local", auth)
        self.assertIn("90", auth)

    def test_running_result_loss_does_not_claim_failure(self):
        support = list(hq_devices.DEFAULT_AGENT_POLICY) + ["files_write", "power_shutdown"]
        enrolled = self._enroll(support=support)
        device_id = enrolled["device_id"]
        hq_companion.set_policy(device_id, support)
        granted = hq_companion.granted_for(device_id)
        queued = hq_jobs.create_job(
            device_id=device_id,
            op="system.status",
            args={},
            origin="human",
            granted=granted,
            ttl_sec=30,
            timeout_sec=20,
        )
        self.assertEqual(queued["expires_at"] - queued["created_at"], 30)
        self.now += 29
        leased = hq_jobs.take_next(device_id)
        self.assertEqual(leased["id"], queued["id"])
        started = hq_jobs.acknowledge_start(device_id, leased["id"], leased["dispatch_token"])
        self.assertEqual(started["state"], "running")
        self.assertGreater(started["run_deadline"], started["expires_at"])
        self.assertEqual(started["run_deadline"], started["started_at"] + 20 + hq_jobs.RUN_GRACE_SEC)
        read_token = leased["dispatch_token"]
        self.now = started["expires_at"] + 1
        self.assertLess(self.now, started["run_deadline"])
        hq_jobs.sweep()
        self.assertEqual(hq_jobs.get_job(queued["id"])["state"], "running")
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.complete(device_id, queued["id"], ok=True, dispatch_token="ab" * 16)
        self.assertEqual(hq_jobs.get_job(queued["id"])["state"], "running")
        self.now = started["run_deadline"] + 1
        hq_jobs.sweep()
        lost = hq_jobs.get_job(queued["id"])
        self.assertEqual(lost["state"], "failed")
        self.assertEqual(lost["error"], "résultat non reçu")
        self.assertEqual(lost["attempts"], started["attempts"])
        self.assertEqual(lost["started_at"], started["started_at"])
        self.assertIsNone(hq_jobs.take_next(device_id))
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.complete(device_id, queued["id"], ok=True, dispatch_token=read_token)

        def lose(op, args, *, approve=False):
            job = hq_jobs.create_job(
                device_id=device_id,
                op=op,
                args=args,
                origin="human",
                granted=granted,
                timeout_sec=20,
            )
            if approve:
                hq_jobs.approve(job["id"], actor="human")
            taken = hq_jobs.take_next(device_id)
            self.assertEqual(taken["id"], job["id"])
            running = hq_jobs.acknowledge_start(device_id, job["id"], taken["dispatch_token"])
            self.now = running["run_deadline"] + 1
            hq_jobs.sweep()
            return hq_jobs.get_job(job["id"])

        safe = lose("power.lock", {})
        self.assertEqual(safe["state"], "uncertain")
        self.assertEqual(safe["error"], "résultat non reçu après démarrage")
        sensitive = lose("fs.write", {"path": "note.txt", "text": "x"})
        self.assertEqual(sensitive["state"], "uncertain")
        destructive = lose("power.shutdown", {}, approve=True)
        self.assertEqual(destructive["state"], "uncertain")

        fresh = hq_jobs.create_job(
            device_id=device_id,
            op="power.lock",
            args={},
            origin="human",
            granted=granted,
            timeout_sec=20,
        )
        taken = hq_jobs.take_next(device_id)
        running = hq_jobs.acknowledge_start(device_id, fresh["id"], taken["dispatch_token"])
        path = self.tmp / "hq_agent_jobs.json"
        stored = json.loads(path.read_text(encoding="utf-8"))
        for row in stored["jobs"]:
            if row["id"] == fresh["id"]:
                row["artifact_reserved"] = True
                row["artifact"] = {
                    "rel": "Inbox/AgentArtifacts/keep.bin",
                    "name": "keep.bin",
                    "size": 4,
                    "sha256": "ab" * 32,
                }
        path.write_text(json.dumps(stored), encoding="utf-8")
        hq_companion.bind(
            self.tmp,
            now=lambda: self.now,
            reserve_bytes=lambda: 0,
            disk_free=lambda _path: {"free": 10**15},
        )
        self.now = running["run_deadline"] + 1
        hq_jobs.sweep()
        settled = json.loads(path.read_text(encoding="utf-8"))
        row = next(item for item in settled["jobs"] if item["id"] == fresh["id"])
        self.assertEqual(row["state"], "uncertain")
        self.assertEqual(row["error"], "résultat non reçu après démarrage")
        self.assertFalse(row["artifact_reserved"])
        self.assertEqual(row["artifact"]["name"], "keep.bin")
        self.assertEqual(row["dispatch_token"], "")
        self.assertEqual(row["lease_until"], 0)
        self.assertEqual(row["attempts"], running["attempts"])
        self.assertEqual(row["started_at"], running["started_at"])
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.complete(device_id, fresh["id"], ok=True, dispatch_token=taken["dispatch_token"])
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.acknowledge_start(device_id, fresh["id"], taken["dispatch_token"])
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.authorize_artifact(device_id, fresh["id"], "keep.bin", 4, taken["dispatch_token"])
