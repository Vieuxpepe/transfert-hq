"""Security audit fixes F2, F3, F4, F5, F7.

Runs on Linux and Windows. Windows-only checks (NTFS DACLs, junctions,
French-locale SIDs, task registration) live in tests/powershell and are
wrapped here behind os.name == "nt" and HQ_WINDOWS_ACL_TESTS=1.
No live controller, no real scheduled task, no real enrollment.
"""

from __future__ import annotations

import http.server
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path

import companion_agent
import hq_agent_ops as ops
import hq_agent_protocol as proto
import hq_companion
import hq_devices
import hq_events
import hq_jobs
import hq_state

ROOT = Path(__file__).resolve().parents[1]
PS_TESTS = ROOT / "tests" / "powershell"


def _strip_ps_comments(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def _ps_function(text: str, name: str) -> str:
    start = text.index(f"function {name}")
    nxt = text.find("\nfunction ", start + 1)
    return text[start:] if nxt < 0 else text[start:nxt]


class _AgentFixture(unittest.TestCase):
    support = list(hq_devices.DEFAULT_AGENT_POLICY) + ["files_write", "power_shutdown"]

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-audit-"))
        self.now = 1_700_000_000.0
        hq_events.bind(self.tmp)
        self._bind()
        self.enrolled = self._enroll()
        self.device_id = self.enrolled["device_id"]
        hq_companion.set_policy(self.device_id, self.support)
        self.granted = hq_companion.granted_for(self.device_id)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _bind(self):
        hq_companion.bind(self.tmp, now=lambda: self.now, reserve_bytes=lambda: 0, disk_free=lambda _path: {"free": 10**15})

    def _enroll(self):
        token = hq_companion.create_enroll_token(label="test")["token"]
        body = {
            "token": token,
            "name": "Audit PC",
            "hostname": "audit-pc",
            "os": "windows",
            "protocol_version": 1,
            "support": self.support,
            "tailscale_ips": ["100.9.9.9"],
        }
        return hq_companion.enroll(token=token, body=body, client_ip="10.1.1.1")

    def _headers(self, path, body: bytes):
        import secrets

        nonce = secrets.token_urlsafe(18)
        stamp = int(self.now)
        return {
            proto.HEADER_DEVICE: self.device_id,
            proto.HEADER_TIME: str(stamp),
            proto.HEADER_NONCE: nonce,
            proto.HEADER_SIGNATURE: proto.sign(self.enrolled["device_secret"], "POST", path, stamp, nonce, body),
        }

    def _start(self, op, args=None, *, approve=False, timeout_sec=20):
        job = hq_jobs.create_job(
            device_id=self.device_id,
            op=op,
            args=args or {},
            origin="human",
            granted=self.granted,
            timeout_sec=timeout_sec,
        )
        if approve or job["state"] == "awaiting_approval":
            hq_jobs.approve(job["id"], actor="human")
        leased = hq_jobs.take_next(self.device_id)
        self.assertEqual(leased["id"], job["id"])
        running = hq_jobs.acknowledge_start(self.device_id, job["id"], leased["dispatch_token"])
        self.assertEqual(running["state"], "running")
        return running, leased["dispatch_token"]

    def _artifact(self, job_id, token, body=b"%PDF-1.4 x", name="note.pdf"):
        headers = self._headers("/agent/v1/artifact", body)
        headers[proto.HEADER_JOB] = job_id
        headers[proto.HEADER_ARTIFACT_NAME] = name
        headers[proto.HEADER_DISPATCH] = token
        return hq_companion.handle_device(method="POST", path="/agent/v1/artifact", headers=headers, body=body)

    def _result(self, job_id, token, ok=True):
        body = json.dumps({"id": job_id, "ok": ok, "summary": "late", "dispatch_token": token}).encode()
        return hq_companion.handle_device(method="POST", path="/agent/v1/result", headers=self._headers("/agent/v1/result", body), body=body)

    def _stored(self, job_id):
        path = hq_state.agent_state_dir(self.tmp) / "hq_agent_jobs.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        return next(row for row in data["jobs"] if row["id"] == job_id)

    def _job_dir(self, job_id):
        return self.tmp / "Inbox" / "AgentArtifacts" / self.device_id / job_id


class LateResultTests(_AgentFixture):
    """F7: a running job past run_deadline is settled before any late input."""

    def test_valid_result_and_artifact_before_deadline_are_accepted(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        self.now = running["run_deadline"]  # boundary: not yet overdue
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 200, payload)
        code, payload = self._result(running["id"], token)
        self.assertEqual(code, 200, payload)
        self.assertEqual(payload["job"]["state"], "succeeded")
        self.assertEqual(self._stored(running["id"])["artifact"]["name"], "note.pdf")

    def test_late_result_without_sweep_read_fails_and_is_not_requeued(self):
        running, token = self._start("system.status")
        self.now = running["run_deadline"] + 1  # no sweep
        code, payload = self._result(running["id"], token)
        self.assertEqual(code, 400, payload)
        self.assertIn("délai", payload["error"])
        row = self._stored(running["id"])
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["error"], "résultat non reçu")
        self.assertEqual(row["dispatch_token"], "")
        self.assertEqual(row["attempts"], running["attempts"])
        self.assertEqual(row["started_at"], running["started_at"])
        self.assertIsNone(hq_jobs.take_next(self.device_id))
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.complete(self.device_id, running["id"], ok=True, dispatch_token=token)
        self.assertEqual(self._stored(running["id"])["state"], "failed")

    def test_late_result_without_sweep_non_read_becomes_uncertain(self):
        for op, args, approve in (
            ("power.lock", {}, False),
            ("fs.write", {"path": "note.txt", "text": "x"}, False),
            ("power.shutdown", {}, True),
        ):
            with self.subTest(op=op):
                running, token = self._start(op, args, approve=approve)
                self.now = running["run_deadline"] + 1
                with self.assertRaises(ops.AgentOpError) as ctx:
                    hq_jobs.complete(self.device_id, running["id"], ok=True, summary="done", dispatch_token=token)
                self.assertIn("délai", str(ctx.exception))
                row = self._stored(running["id"])
                self.assertEqual(row["state"], "uncertain")
                self.assertEqual(row["error"], "résultat non reçu après démarrage")
                self.assertNotEqual(row.get("summary"), "done")
                self.assertEqual(row["dispatch_token"], "")
                self.assertIsNone(hq_jobs.take_next(self.device_id))

    def test_late_artifact_authorization_is_refused_and_writes_nothing(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        self.now = running["run_deadline"] + 1
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 400, payload)
        self.assertFalse(self._job_dir(running["id"]).exists())
        row = self._stored(running["id"])
        self.assertEqual(row["state"], "failed")
        self.assertFalse(row["artifact_reserved"])
        self.assertIsNone(row.get("artifact"))
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.authorize_artifact(self.device_id, running["id"], "note.pdf", 4, token)

    def test_attach_after_deadline_is_refused_and_bytes_removed(self):
        running, token = self._start("screenshot.capture")
        real = hq_jobs.authorize_artifact

        def authorize_then_expire(*args, **kwargs):
            out = real(*args, **kwargs)
            self.now = running["run_deadline"] + 1  # the write finishes late
            return out

        hq_jobs.authorize_artifact = authorize_then_expire
        try:
            code, payload = self._artifact(running["id"], token, body=b"PNG-late", name="shot.png")
        finally:
            hq_jobs.authorize_artifact = real
        self.assertEqual(code, 400, payload)
        job_dir = self._job_dir(running["id"])
        leftovers = [p for p in job_dir.rglob("*")] if job_dir.exists() else []
        self.assertEqual(leftovers, [])
        row = self._stored(running["id"])
        self.assertEqual(row["state"], "failed")
        self.assertIsNone(row.get("artifact"))
        self.assertFalse(row["artifact_reserved"])

    def test_attached_artifact_is_preserved_when_late_result_settles(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 200, payload)
        rel = payload["artifact"]["rel"]
        self.now = running["run_deadline"] + 1
        code, payload = self._artifact(running["id"], token, body=b"second", name="two.pdf")
        self.assertEqual(code, 400, payload)
        code, payload = self._result(running["id"], token)
        self.assertEqual(code, 400, payload)
        row = self._stored(running["id"])
        self.assertEqual(row["state"], "failed")
        self.assertEqual(row["artifact"]["rel"], rel)
        self.assertEqual((self.tmp / rel).read_bytes(), b"%PDF-1.4 x")
        self.assertFalse(self._job_dir(running["id"]).joinpath("two.pdf").exists())

    def test_non_read_with_artifact_settles_uncertain_and_keeps_it(self):
        running, token = self._start("power.lock")
        path = hq_state.agent_state_dir(self.tmp) / "hq_agent_jobs.json"
        stored = json.loads(path.read_text(encoding="utf-8"))
        for row in stored["jobs"]:
            if row["id"] == running["id"]:
                row["artifact"] = {"rel": "Inbox/AgentArtifacts/keep.bin", "name": "keep.bin", "size": 4, "sha256": "ab" * 32}
        path.write_text(json.dumps(stored), encoding="utf-8")
        self._bind()
        self.now = running["run_deadline"] + 1
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.attach_artifact(self.device_id, running["id"], {"rel": "x", "name": "x", "size": 1, "sha256": "cd" * 32}, dispatch_token=token)
        row = self._stored(running["id"])
        self.assertEqual(row["state"], "uncertain")
        self.assertEqual(row["artifact"]["name"], "keep.bin")
        self.assertIsNone(hq_jobs.take_next(self.device_id))

    def test_late_start_ack_settles_too(self):
        running, token = self._start("power.lock")
        self.now = running["run_deadline"] + 1
        with self.assertRaises(ops.AgentOpError):
            hq_jobs.acknowledge_start(self.device_id, running["id"], token)
        self.assertEqual(self._stored(running["id"])["state"], "uncertain")


@unittest.skipUnless(hasattr(os, "symlink"), "os.symlink indisponible")
class ArtifactLinkTests(_AgentFixture):
    """F4: no link is followed anywhere under Inbox/AgentArtifacts."""

    def setUp(self):
        super().setUp()
        self.outside = self.tmp / "outside"
        self.outside.mkdir()
        self.sentinel = self.outside / "sentinel.bin"
        self.sentinel.write_bytes(b"SENTINEL-BYTES")

    def _symlink(self, link: Path, target: Path, *, directory=False):
        try:
            os.symlink(target, link, target_is_directory=directory)
        except (OSError, NotImplementedError) as exc:
            self.skipTest(f"lien symbolique non autorisé ici: {exc}")

    def _assert_sentinel(self):
        self.assertEqual(self.sentinel.read_bytes(), b"SENTINEL-BYTES")
        self.assertEqual(sorted(p.name for p in self.outside.iterdir()), ["sentinel.bin"])

    def test_planted_partial_symlink_is_refused_and_not_followed(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        job_dir = self._job_dir(running["id"])
        job_dir.mkdir(parents=True)
        partial = job_dir / "note.pdf.partial"
        self._symlink(partial, self.sentinel)
        code, payload = self._artifact(running["id"], token, body=b"ATTACKER-SEES-THIS")
        self.assertEqual(code, 400, payload)
        self._assert_sentinel()
        self.assertTrue(partial.is_symlink())  # not ours: left alone, never opened
        self.assertFalse((job_dir / "note.pdf").exists())
        row = self._stored(running["id"])
        self.assertEqual(row["state"], "running")
        self.assertFalse(row["artifact_reserved"])
        os.unlink(partial)
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 200, payload)
        self.assertEqual((job_dir / "note.pdf").read_bytes(), b"%PDF-1.4 x")
        self._assert_sentinel()

    def test_dangling_partial_symlink_is_refused(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        job_dir = self._job_dir(running["id"])
        job_dir.mkdir(parents=True)
        self._symlink(job_dir / "note.pdf.partial", self.outside / "created-by-attack.bin")
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 400, payload)
        self._assert_sentinel()

    def test_planted_final_name_symlink_is_refused(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        job_dir = self._job_dir(running["id"])
        job_dir.mkdir(parents=True)
        self._symlink(job_dir / "note.pdf", self.sentinel)
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 400, payload)
        self._assert_sentinel()
        self.assertTrue((job_dir / "note.pdf").is_symlink())

    def test_symlinked_directory_components_are_refused(self):
        for level in ("AgentArtifacts", "device", "job"):
            with self.subTest(level=level):
                running, token = self._start("fs.stage", {"path": "note.pdf"})
                base = self.tmp / "Inbox" / "AgentArtifacts"
                shutil.rmtree(self.tmp / "Inbox", ignore_errors=True)
                (self.tmp / "Inbox").mkdir()
                if level == "AgentArtifacts":
                    link = base
                elif level == "device":
                    base.mkdir()
                    link = base / self.device_id
                else:
                    (base / self.device_id).mkdir(parents=True)
                    link = base / self.device_id / running["id"]
                self._symlink(link, self.outside, directory=True)
                code, payload = self._artifact(running["id"], token)
                self.assertEqual(code, 400, payload)
                self._assert_sentinel()
                os.unlink(link)
                hq_jobs.complete(self.device_id, running["id"], ok=True, dispatch_token=token)

    def test_ordinary_upload_and_quota_still_work(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        code, payload = self._artifact(running["id"], token)
        self.assertEqual(code, 200, payload)
        rel = payload["artifact"]["rel"]
        self.assertTrue(rel.startswith(f"Inbox/AgentArtifacts/{self.device_id}/"))
        self.assertEqual((self.tmp / rel).read_bytes(), b"%PDF-1.4 x")
        self.assertEqual([p.name for p in self._job_dir(running["id"]).iterdir()], ["note.pdf"])
        hq_jobs.complete(self.device_id, running["id"], ok=True, dispatch_token=token)
        original = hq_companion.DEVICE_ARTIFACT_MAX_FILES
        hq_companion.DEVICE_ARTIFACT_MAX_FILES = 1
        try:
            second, token2 = self._start("fs.stage", {"path": "note.pdf"})
            code, payload = self._artifact(second["id"], token2)
        finally:
            hq_companion.DEVICE_ARTIFACT_MAX_FILES = original
        self.assertEqual(code, 400, payload)
        self.assertIn("quota", payload["error"])
        self.assertFalse(self._job_dir(second["id"]).exists())

    def test_windows_reparse_attribute_is_detected(self):
        reparse = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0x400)
        plain = types.SimpleNamespace(st_mode=stat.S_IFDIR | 0o755, st_file_attributes=0x10)
        link = types.SimpleNamespace(st_mode=stat.S_IFLNK | 0o777)
        self.assertTrue(hq_companion._is_link_or_reparse(reparse))
        self.assertFalse(hq_companion._is_link_or_reparse(plain))
        self.assertTrue(hq_companion._is_link_or_reparse(link))


@unittest.skipUnless(os.name == "nt", "jonction NTFS: Windows seulement")
class ArtifactJunctionWindowsTests(_AgentFixture):
    """F4 on NTFS: a junction for the job directory is refused."""

    def test_junction_job_directory_is_refused(self):
        running, token = self._start("fs.stage", {"path": "note.pdf"})
        outside = self.tmp / "outside"
        outside.mkdir()
        sentinel = outside / "sentinel.bin"
        sentinel.write_bytes(b"SENTINEL-BYTES")
        parent = self.tmp / "Inbox" / "AgentArtifacts" / self.device_id
        parent.mkdir(parents=True)
        link = parent / running["id"]
        made = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(outside)], capture_output=True, text=True, check=False)
        if made.returncode != 0:
            self.skipTest("mklink /J indisponible")
        try:
            code, payload = self._artifact(running["id"], token)
            self.assertEqual(code, 400, payload)
            self.assertEqual(sentinel.read_bytes(), b"SENTINEL-BYTES")
            self.assertEqual(sorted(p.name for p in outside.iterdir()), ["sentinel.bin"])
        finally:
            os.rmdir(link)  # removes the junction, not the target


class _MockControllerHandler(http.server.BaseHTTPRequestHandler):
    server_version = "MockHQ"
    log_lines: list[str] = []

    def log_message(self, fmt, *args):  # captured, never printed
        self.log_lines.append(fmt % args)

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length)
        code, payload = hq_companion.handle_device(
            method="POST", path=self.path, headers=self.headers, body=body, client_ip=self.client_address[0]
        )
        raw = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


class EnrollmentInputTests(unittest.TestCase):
    """F3: the enrollment token never travels in argv, output, logs, or the task."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-enroll-"))
        self.controller_root = self.tmp / "controller"
        self.events = []
        hq_events.bind(self.controller_root)
        hq_companion.bind(self.controller_root, journal=lambda *a, **k: self.events.append((a, k)))
        _MockControllerHandler.log_lines = []
        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _MockControllerHandler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.config = self.tmp / "pc" / "agent_config.json"

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _argv(self, *extra):
        return [
            sys.executable,
            str(ROOT / "companion_agent.py"),
            "--config",
            str(self.config),
            "--controller",
            self.url,
            "--dev",
            "--name",
            "Audit PC",
            "--json",
            *extra,
        ]

    def _env(self):
        env = os.environ.copy()
        env["PYTHONPATH"] = str(ROOT)
        env["PYTHONIOENCODING"] = "utf-8"
        return env

    def _everything_captured(self, *parts) -> str:
        return "\n".join(
            [*map(str, parts), *_MockControllerHandler.log_lines, repr(self.events)]
            + [p.read_text(encoding="utf-8", errors="replace") for p in self.controller_root.rglob("*.json")]
        )

    def test_enroll_via_stdin_never_exposes_token(self):
        token = hq_companion.create_enroll_token(label="audit")["token"]
        argv = self._argv("--enroll")
        self.assertNotIn(token, " ".join(argv))
        proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=self._env(), cwd=str(self.tmp))
        cmdline = ""
        proc_file = Path(f"/proc/{proc.pid}/cmdline")
        if proc_file.exists():
            deadline = time.time() + 10
            while time.time() < deadline:
                try:
                    cmdline = proc_file.read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
                except OSError:
                    break
                if "companion_agent.py" in cmdline:
                    break
                time.sleep(0.02)
            self.assertIn("--enroll", cmdline)
        out, err = proc.communicate(input=(token + "\n").encode("utf-8"), timeout=30)
        stdout, stderr = out.decode("utf-8", "replace"), err.decode("utf-8", "replace")
        self.assertEqual(proc.returncode, 0, stderr)
        result = json.loads(stdout)
        self.assertTrue(result["ok"])
        self.assertTrue(result["device_id"].startswith("ag_"))
        self.assertNotIn(token, cmdline)
        self.assertNotIn(token, stdout)
        self.assertNotIn(token, stderr)
        self.assertNotIn(token, self._everything_captured())
        self.assertNotIn(token, self.config.read_text(encoding="utf-8"))
        self.assertTrue(any("/agent/v1/enroll" in line for line in _MockControllerHandler.log_lines))
        # One-time: the same token is spent.
        again = subprocess.run(self._argv("--enroll"), input=(token + "\n").encode(), capture_output=True, env=self._env(), cwd=str(self.tmp), timeout=30)
        self.assertNotEqual(again.returncode, 0)
        self.assertNotIn(token, again.stdout.decode("utf-8", "replace") + again.stderr.decode("utf-8", "replace"))

    def test_token_as_argument_is_refused_without_echo_or_use(self):
        token = hq_companion.create_enroll_token(label="audit")["token"]
        for argv in (self._argv("--enroll", token), self._argv(f"--enroll={token}")):
            with self.subTest(form=argv[-1][:9]):
                proc = subprocess.run(argv, capture_output=True, env=self._env(), cwd=str(self.tmp), timeout=30, input=b"")
                self.assertEqual(proc.returncode, 2)
                both = proc.stdout.decode("utf-8", "replace") + proc.stderr.decode("utf-8", "replace")
                self.assertNotIn(token, both)
                self.assertIn("--enroll seul", both)
        self.assertEqual(_MockControllerHandler.log_lines, [])
        self.assertFalse(self.config.exists())
        # The refused token was never sent, so it still works through stdin.
        ok = subprocess.run(self._argv("--enroll"), input=(token + "\n").encode(), capture_output=True, env=self._env(), cwd=str(self.tmp), timeout=30)
        self.assertEqual(ok.returncode, 0, ok.stderr.decode("utf-8", "replace"))

    def test_bad_option_does_not_echo_values(self):
        secret_like = "-" + "Zq" * 20
        proc = subprocess.run(self._argv("--enroll", secret_like), capture_output=True, env=self._env(), cwd=str(self.tmp), timeout=30, input=b"")
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn(secret_like, proc.stdout.decode() + proc.stderr.decode())

    def test_read_token_masked_prompt_and_stdin(self):
        token = "Ab_" + "x9" * 20
        prompts = []

        class Tty(io.StringIO):
            def isatty(self):
                return True

        got = companion_agent.read_enroll_token(stdin=Tty(""), prompt=lambda text: prompts.append(text) or token)
        self.assertEqual(got, token)
        self.assertEqual(prompts, [companion_agent.ENROLL_PROMPT])
        self.assertNotIn(token, prompts[0])
        self.assertEqual(companion_agent.read_enroll_token(stdin=io.StringIO("\ufeff" + token + "\r\n")), token)
        for bad in ("", "\n", "short\n", "has space " + "x" * 20 + "\n"):
            with self.assertRaises(ops.AgentOpError) as ctx:
                companion_agent.read_enroll_token(stdin=io.StringIO(bad))
            self.assertNotIn(bad.strip() or "\0", str(ctx.exception))

    def test_installer_task_and_instructions_are_config_only(self):
        install = (ROOT / "install_companion.ps1").read_text(encoding="utf-8")
        task_arg = _ps_function(install, "Get-CompanionTaskArgument")
        self.assertIn('return "-3 `"$ScriptPath`" --config `"$ConfigPath`""', task_arg)
        register = _ps_function(install, "Register-CompanionTask")
        for text in (task_arg, register):
            lowered = _strip_ps_comments(text).lower()
            for word in ("enroll", "jeton", "token", "device_secret"):
                self.assertNotIn(word, lowered)
        self.assertIn('--workspace `"$Work`" --enroll"', install)
        self.assertNotIn("--enroll JETON", install)
        self.assertNotRegex(_strip_ps_comments(install), r"--enroll\s+[\"'$A-Za-z]")
        self.assertIn("saisie masquée", install)


class InstallCompanionStaticTests(unittest.TestCase):
    """F2 structure. The runtime proof is tests/powershell (Windows)."""

    def setUp(self):
        self.src = (ROOT / "install_companion.ps1").read_text(encoding="utf-8")
        self.code = _strip_ps_comments(self.src)

    def test_no_localized_account_names_in_acl_code(self):
        for word in ("Administrators", "Administrateurs", "Everyone", "Tout le monde", "BUILTIN\\Users", "NT AUTHORITY", "icacls"):
            self.assertNotIn(word, self.code)
        self.assertNotRegex(self.code, r"\bSYSTEM\b")
        self.assertIn('"S-1-5-18"', self.code)
        self.assertIn('"S-1-5-32-544"', self.code)
        self.assertIn("[Security.Principal.WindowsIdentity]::GetCurrent().User.Value", self.code)

    def test_single_writer_protected_allowlist(self):
        self.assertEqual(self.code.count("SetAccessControl("), 2)  # .NET Framework + FileSystemAclExtensions
        writer = _ps_function(self.src, "Set-CompanionDacl")
        self.assertEqual(writer.count("SetAccessControl("), 2)
        self.assertNotIn("Set-Acl", self.code)
        sddl = _ps_function(self.src, "Get-CompanionAllowlistSddl")
        self.assertIn('"D:P(', sddl)
        self.assertEqual(sddl.count("(A;$flags;"), 3)
        self.assertNotIn("(D;", sddl)

    def test_verification_by_sid_before_task(self):
        check = _ps_function(self.src, "Get-CompanionAclProblems")
        self.assertIn("GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])", check)
        self.assertIn("AreAccessRulesProtected", check)
        self.assertIn("GetOwner([System.Security.Principal.SecurityIdentifier])", check)
        self.assertIn("SID non autorisé", check)
        self.assertIn("entrée manquante", check)
        body = _ps_function(self.src, "Invoke-CompanionInstall")
        first_write = body.index("Set-CompanionAllowlistAcl")
        self.assertLess(body.index("Get-CompanionTreeItems"), first_write)
        self.assertLess(body.index("throw (\"REFUS: ACL non conforme"), body.index("Register-CompanionTask"))
        self.assertEqual(self.code.count("Register-ScheduledTask "), 1)
        self.assertIn("Register-ScheduledTask", _ps_function(self.src, "Register-CompanionTask"))
        tree = _strip_ps_comments(_ps_function(self.src, "Get-CompanionTreeItems"))
        self.assertIn("ReparsePoint", tree)
        self.assertNotIn("-Recurse", tree)
        self.assertIn('if ($MyInvocation.InvocationName -eq ".") {', self.src)
        self.assertIn("Remove-Item -LiteralPath $target", body)
        self.assertLess(body.index("Remove-Item -LiteralPath $target"), body.index("Copy-Item"))


class TreeAclStaticTests(unittest.TestCase):
    """F5 structure and -WhatIf purity. Runtime proof is tests/powershell."""

    def setUp(self):
        self.src = (ROOT / "install_hq_tree_acl.ps1").read_text(encoding="utf-8")
        self.code = _strip_ps_comments(self.src)

    def test_only_root_state_dir_is_delegated(self):
        self.assertNotIn('$item.Name -eq ".hq-agent-state"', self.code)
        self.assertEqual(self.code.count("if (Test-DelegatedStateDir $item)"), 3)
        helper = _ps_function(self.src, "Test-DelegatedStateDir")
        self.assertIn("GetFullPath", helper)
        self.assertIn("OrdinalIgnoreCase", helper)
        self.assertIn("$script:PrivateStateFull", helper)
        self.assertIn('$script:PrivateStateFull = [System.IO.Path]::GetFullPath($privateState)', self.code)

    def test_nested_state_dir_fails_closed_in_verify(self):
        verify = self.code.split("if (-not $WhatIfPreference) {", 1)[1]
        self.assertIn("ACE explicite conservée", verify)
        self.assertIn("héritage coupé hors liste", verify)
        self.assertLess(verify.index("ACE explicite conservée"), verify.index("Write-Host \"ACL d'arbre préparée"))

    def test_whatif_has_no_owner_acl_or_filesystem_write(self):
        mutators = (".SetOwner(", "Set-Acl", ".AddAccessRule(", ".RemoveAccessRule(", ".SetAccessRuleProtection(")
        allowed_homes = {"Save-SecurityDescriptor", "Add-AllowRule", "Remove-ExplicitRules"}
        functions = {m.group(1) for m in re.finditer(r"^function ([A-Za-z-]+)", self.src, re.M)}
        outside = self.code
        for name in functions:
            body = _strip_ps_comments(_ps_function(self.src, name))
            if name in allowed_homes:
                outside = outside.replace(body, "")
            else:
                for token in mutators + ("Add-AllowRule", "Remove-ExplicitRules"):
                    self.assertNotIn(token, body, f"{token} dans {name}")
        for token in mutators:
            self.assertNotIn(token, outside)
        for helper in ("Add-AllowRule $", "Remove-ExplicitRules $"):
            self.assertNotIn(helper, outside)
        save = _ps_function(self.src, "Save-SecurityDescriptor")
        guard = save.index("if ($WhatIfPreference) {")
        for token in (".SetOwner(", "Set-Acl", "Add-AllowRule", "Remove-ExplicitRules", ".SetAccessRuleProtection("):
            self.assertGreater(save.index(token), guard)
        for writer in (
            "New-Item", "Copy-Item", "Move-Item", "Rename-Item", "Remove-Item", "Set-Content", "Add-Content",
            "Out-File", "Set-ItemProperty", "Clear-Content", "[IO.File]::", "[System.IO.File]::", "WriteAll",
        ):
            self.assertNotIn(writer, self.code)


def _powershell() -> str | None:
    for name in ("pwsh", "powershell"):
        found = shutil.which(name)
        if found:
            return found
    return None


@unittest.skipUnless(_powershell(), "PowerShell absent")
class InstallCompanionFlowTests(unittest.TestCase):
    """F2 ordering with every ACL and task seam mocked. Runs under pwsh anywhere."""

    def test_flow_script(self):
        script = PS_TESTS / "Test-InstallCompanionFlow.ps1"
        proc = subprocess.run(
            [_powershell(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(script)],
            capture_output=True, text=True, timeout=180, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("RESULT: PASS", proc.stdout)


_WINDOWS_ACL = os.name == "nt" and os.environ.get("HQ_WINDOWS_ACL_TESTS") == "1"


@unittest.skipUnless(_WINDOWS_ACL, "NTFS réel: Windows avec HQ_WINDOWS_ACL_TESTS=1")
class WindowsAclTests(unittest.TestCase):
    """F2 and F5 on a real NTFS volume, in isolated temp trees only."""

    def _run(self, name):
        proc = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", str(PS_TESTS / name)],
            capture_output=True, text=True, timeout=600, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("RESULT: PASS", proc.stdout)

    def test_install_companion_acl(self):
        self._run("Test-InstallCompanionAcl.ps1")

    def test_tree_acl_nested_state_dir(self):
        self._run("Test-TreeAclNestedState.ps1")


if __name__ == "__main__":
    unittest.main()
