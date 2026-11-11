"""Exact-port infrastructure tests.

Ephemeral ports and disposable sessions only. A passing run does not prove a
browser loaded http://127.0.0.1:8765 and called http://127.0.0.1:8776.
"""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, urlopen

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_exact_port_recovery as recovery  # noqa: E402
import hq_forge_lifecycle as life  # noqa: E402
import hq_forge_lifecycle_listener as gate  # noqa: E402
import importlib.util  # noqa: E402

_PAGE_SPEC = importlib.util.spec_from_file_location("m2b_exact_port_page", Path(__file__).with_name("m2b_exact_port_page.py"))
page_launcher = importlib.util.module_from_spec(_PAGE_SPEC)
_PAGE_SPEC.loader.exec_module(page_launcher)
_PUBLICATION_SPEC = importlib.util.spec_from_file_location(
    "m2b_publication_tests",
    Path(__file__).with_name("m2b_publication.py"),
)
publication = importlib.util.module_from_spec(_PUBLICATION_SPEC)
_PUBLICATION_SPEC.loader.exec_module(publication)

PAGE_BIND_PERMITTED = page_launcher.PAGE_BIND_PERMITTED
PIN = page_launcher.PIN
assert_checkout = page_launcher.assert_checkout
assert_disposable_session_path = page_launcher.assert_disposable_session_path
fixed_page_decision = page_launcher.fixed_page_decision
page_main = page_launcher.main
start_ephemeral_page = page_launcher.start_ephemeral_page
start_fixed_page = page_launcher.start_fixed_page

PYTHON = Path(r"C:\Python313\python.exe")
NOW = 1_800_000_000
SERVE_BYTES = (
    '{"TCP":{"443":{"HTTPS":true}},'
    '"Web":{"vieuxpeepee.taila4d470.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:8765"}}}}}'
).encode("ascii")
SERVE_HASH = hashlib.sha256(SERVE_BYTES).hexdigest()


def listening() -> dict[int, int]:
    completed = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    found: dict[int, int] = {}
    for line in completed.stdout.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[3] != "LISTENING":
            continue
        for port in (7860, 8765, 8766, 8776):
            if parts[1].endswith(f":{port}"):
                found[port] = int(parts[4])
    return found


def observed(record: dict, argv: list[str] | None = None) -> dict:
    if argv is None:
        argv = [record["executable"], record["script"]]
    return {
        "pid": record["pid"],
        "creation": record["creation"],
        "executable": record["executable"],
        "argv": argv,
    }


def empty_ports() -> dict:
    return {name: None for name in recovery.PORT_NAMES}


def forge_record() -> dict:
    return {
        "pid": 424242,
        "creation": 100,
        "executable": recovery.FORGE_EXECUTABLE,
        "script": recovery.FORGE_SCRIPT,
    }


def page_record(pid: int = 51001) -> dict:
    return {"pid": pid, "creation": 200, "executable": recovery.PYTHON_EXE, "script": recovery.PAGE_SCRIPT}


def listener_record(pid: int = 51002) -> dict:
    return {"pid": pid, "creation": 201, "executable": recovery.PYTHON_EXE, "script": recovery.LISTENER_SCRIPT}


def hq_record(pid: int = 61001) -> dict:
    return {"pid": pid, "creation": 300, "executable": recovery.PYTHON_EXE, "script": recovery.PRODUCTION_SCRIPT}


def payload_for(phase: str) -> dict:
    forge = forge_record()
    page = page_record()
    listener = listener_record()
    hq = hq_record()
    ports = empty_ports()
    ports["7860"] = {
        "pid": forge["pid"],
        "creation": forge["creation"],
        "executable": forge["executable"],
        "script": forge["script"],
    }
    body = {
        "version": 1,
        "written_at": NOW,
        "production_head": recovery.PRODUCTION_HEAD,
        "worktree_head": recovery.WORKTREE_HEAD,
        "phase": phase,
        "maintenance_authorized": False,
        "forge": forge,
        "production_hq": None,
        "stopped_hq": None,
        "test_page": None,
        "listener": None,
        "ports": ports,
        "serve": {"paused": True, "config_checksum": SERVE_HASH, "funnel": False},
    }
    if phase == "serve-paused":
        body["production_hq"] = hq
        ports["8765"] = dict(hq)
        ports["8766"] = dict(hq)
    elif phase == "test-running":
        body["test_page"] = page
        body["listener"] = listener
        body["stopped_hq"] = hq
        ports["8765"] = dict(page)
        ports["8776"] = dict(listener)
    elif phase == "listener-down":
        body["test_page"] = page
        body["stopped_hq"] = hq
        ports["8765"] = dict(page)
    elif phase in {"hq-stopped", "ports-free"}:
        body["stopped_hq"] = hq
    elif phase == "hq-verified":
        body["production_hq"] = hq
        ports["8765"] = dict(hq)
        ports["8766"] = dict(hq)
    elif phase == "restored":
        body["production_hq"] = hq
        body["serve"] = {"paused": False, "config_checksum": SERVE_HASH, "funnel": False}
        ports["8765"] = dict(hq)
        ports["8766"] = dict(hq)
    return body


def live_from(body: dict) -> dict:
    ports = empty_ports()
    mapping = {
        "8765": body["ports"]["8765"],
        "8766": body["ports"]["8766"],
        "7860": body["ports"]["7860"],
        "8776": body["ports"]["8776"],
    }
    for name, record in mapping.items():
        ports[name] = None if record is None else observed(record)
    return ports


def observer_for(body: dict):
    table = {}
    for record in (body["forge"], body["production_hq"], body["stopped_hq"], body["test_page"], body["listener"]):
        if record is not None:
            table[record["pid"]] = observed(record)

    def observe(pid: int):
        return table.get(pid)

    return observe


class Checkout(unittest.TestCase):
    def test_worktree_identity_and_disposable_sessions(self) -> None:
        facts = assert_checkout(fixed=False)
        self.assertEqual(facts["baseline"], "7fb650bb4097c789cc2027164f20a7b44cfe99c2")
        self.assertEqual(facts["tree"], recovery.WORKTREE_HEAD)
        self.assertEqual(len(facts["head"]), 40)
        self.assertEqual(facts["root"], str(recovery.PAGE_SCRIPT and Path(r"C:\Transfert-worktrees\forge-lifecycle-m1")))
        with self.assertRaises(RuntimeError):
            assert_disposable_session_path(Path(r"C:\Transfert\bridge_sessions.json"))
        with self.assertRaises(RuntimeError):
            assert_disposable_session_path(SOURCE / "bridge_sessions.json")
        with self.assertRaises(RuntimeError):
            gate.assert_isolated_session_path(Path(r"C:\Transfert\bridge_sessions.json"))
        disposable = assert_disposable_session_path(Path(tempfile.gettempdir()) / "m2b-exact-not-created.json")
        self.assertNotIn(Path(r"C:\Transfert").resolve(), disposable.parents)

    def test_approved_checkpoint_validates_and_other_heads_are_refused(self) -> None:
        baseline = "7fb650bb4097c789cc2027164f20a7b44cfe99c2"
        unrelated = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        self.assertEqual(page_launcher.source_identity.APPROVED_BASELINE, baseline)
        self.assertEqual(page_launcher.source_identity.APPROVED_TREE, recovery.WORKTREE_HEAD)
        self.assertEqual(assert_checkout(fixed=False)["tree"], recovery.WORKTREE_HEAD)
        accepted = recovery.validate_payload(payload_for("ports-free"), now=NOW)
        self.assertEqual(accepted["worktree_head"], recovery.WORKTREE_HEAD)
        rejected = payload_for("ports-free")
        rejected["worktree_head"] = unrelated
        with self.assertRaises(recovery.RecoveryError) as caught:
            recovery.validate_payload(rejected, now=NOW)
        self.assertEqual(caught.exception.code, "inconsistent")

    def test_disposable_commit_accepts_the_approved_tree(self) -> None:
        import shutil
        root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        other = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        try:
            self.assertEqual(self._git(root, "init", "-b", "fixture").returncode, 0)
            marker = root / "marker.txt"
            identity = root / "hq_forge_source_identity.py"
            marker.write_bytes(b"baseline\n")
            identity.write_bytes(b'APPROVED_TREE = "0000000000000000000000000000000000000000"\n')
            self.assertEqual(self._git(root, "add", "--", "marker.txt", "hq_forge_source_identity.py").returncode, 0)
            self._commit(root, "baseline")
            baseline = self._git(root, "rev-parse", "HEAD").stdout.decode("ascii").strip()
            marker.write_bytes(b"approved\n")
            tree = page_launcher.source_identity.reviewed_tree(root)
            identity.write_bytes(f'APPROVED_TREE = "{tree}"\n'.encode("ascii"))
            self.assertEqual(page_launcher.source_identity.reviewed_tree(root), tree)
            self.assertEqual(self._git(root, "add", "--", "marker.txt", "hq_forge_source_identity.py").returncode, 0)
            self._commit(root, "approved")
            approved_head = self._git(root, "rev-parse", "HEAD").stdout.decode("ascii").strip()
            self.assertNotEqual(approved_head, baseline)
            self.assertEqual(page_launcher.source_identity.reviewed_tree(root), tree)
            accepted = page_launcher.assert_source_tree(root, baseline=baseline, tree=tree, fixed=True)
            recovered = recovery.assert_source_tree(root, baseline=baseline, tree=tree, fixed=True)
            self.assertEqual(accepted["tree"], tree)
            self.assertEqual(recovered["tree"], tree)
            self.assertTrue(accepted["clean"])
            self.assertEqual(accepted["head"], approved_head)
            self._commit(root, "same tree", allow_empty=True)
            later_head = self._git(root, "rev-parse", "HEAD").stdout.decode("ascii").strip()
            self.assertNotEqual(later_head, approved_head)
            later = page_launcher.assert_source_tree(root, baseline=baseline, tree=tree, fixed=True)
            self.assertEqual(later["head"], later_head)
            self.assertEqual(later["tree"], tree)
            self.assertEqual(recovery.assert_source_tree(root, baseline=baseline, tree=tree, fixed=True)["tree"], tree)
            marker.write_bytes(b"changed\n")
            with self.assertRaises(page_launcher.source_identity.IdentityError):
                page_launcher.assert_source_tree(root, baseline=baseline, tree=tree, fixed=True)
            with self.assertRaises(recovery.RecoveryError) as caught:
                recovery.assert_source_tree(root, baseline=baseline, tree=tree, fixed=False)
            self.assertEqual(caught.exception.code, "inconsistent")
            self.assertEqual(self._git(other, "init", "-b", "fixture").returncode, 0)
            (other / "marker.txt").write_bytes(b"other\n")
            self.assertEqual(self._git(other, "add", "--", "marker.txt").returncode, 0)
            self._commit(other, "unrelated")
            with self.assertRaises(page_launcher.source_identity.IdentityError):
                page_launcher.assert_source_tree(other, baseline=baseline, tree=tree, fixed=True)
            with self.assertRaises(recovery.RecoveryError) as unrelated:
                recovery.assert_source_tree(other, baseline=baseline, tree=tree, fixed=True)
            self.assertEqual(unrelated.exception.code, "inconsistent")
        finally:
            shutil.rmtree(root, ignore_errors=True)
            shutil.rmtree(other, ignore_errors=True)

    def _git(self, root: Path, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            ["git", "-C", str(root), *args],
            check=False,
            capture_output=True,
        )

    def _commit(self, root: Path, message: str, allow_empty: bool = False) -> None:
        command = [
            "git", "-C", str(root),
            "-c", "user.name=fixture",
            "-c", "user.email=fixture@example.invalid",
            "commit", "-m", message,
        ]
        if allow_empty:
            command.append("--allow-empty")
        completed = subprocess.run(command, check=False, capture_output=True)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", errors="replace"))

    def test_ephemeral_page_imports_the_worktree_bridge(self) -> None:
        before = listening()
        handle = start_ephemeral_page()
        try:
            self.assertEqual(handle.identity["bridge_root"], str(SOURCE.resolve()))
            self.assertEqual(handle.identity["script"], str((SOURCE / "tests" / "m2b_exact_port_page.py").resolve()))
            self.assertEqual(handle.identity["pid"], os.getpid())
            self.assertNotIn(handle.port, gate.RESERVED_PORTS)
            self.assertNotIn(Path(r"C:\Transfert").resolve(), Path(handle.identity["sessions"]).resolve().parents)
            self.assertNotIn("pin", handle.identity)
            self.assertEqual(handle.identity["generation"], int(handle.identity["generation"]))
            try:
                with urlopen(f"http://127.0.0.1:{handle.port}/lifecycle/start", timeout=5) as response:
                    status = response.status
            except HTTPError as exc:
                status = exc.code
            self.assertEqual(status, 404)
        finally:
            handle.close()
        after = listening()
        for port in (7860, 8765, 8766, 8776):
            self.assertEqual(before.get(port), after.get(port), port)


class FixedPortGate(unittest.TestCase):
    def test_listener_and_page_stay_disabled(self) -> None:
        self.assertIs(life.FORGE_LAUNCH_ENABLED, False)
        self.assertIs(life.PRODUCT_LISTENER_ENABLED, False)
        self.assertIs(gate.EXACT_PORT_LISTENER_ENABLED, False)
        self.assertIs(gate.EXACT_PORT_BIND_PERMITTED, False)
        self.assertIs(PAGE_BIND_PERMITTED, False)
        self.assertIs(recovery.MAINTENANCE_RECOVERY_ENABLED, False)
        with self.assertRaises(RuntimeError):
            fixed_page_decision(authorized=True, clean=True)
        with self.assertRaises(RuntimeError):
            gate.fixed_listener_decision(authorized=False)
        with self.assertRaises(RuntimeError):
            gate.assert_fixed_listener_bind(8776, authorized=False)
        with self.assertRaises(RuntimeError):
            start_fixed_page()
        self.assertEqual(page_main(["--fixed"]), 2)
        before = listening()
        sessions = Path(tempfile.mkdtemp(prefix="m2b-exact-")) / "bridge_sessions.json"
        supervisor = life.Supervisor(
            sessions.parent,
            f"Local\\TransfertHQ-M1-{uuid.uuid4().hex[:8]}",
            f"Local\\TransfertHQ-M1-Mutex-{uuid.uuid4().hex[:8]}",
        )
        try:
            with self.assertRaises(RuntimeError):
                gate.LifecycleListener(
                    supervisor,
                    "http://127.0.0.1:9100",
                    sessions,
                    1,
                    os.getpid(),
                    int(life.process_creation(os.getpid()) or 0),
                    lambda: "ready",
                    listen_port=8776,
                    fixed_port_authorized=True,
                )
            gate.EXACT_PORT_LISTENER_ENABLED = True
            try:
                self.assertEqual(gate.fixed_listener_decision(authorized=True), ("127.0.0.1", 8776))
                with self.assertRaises(RuntimeError):
                    gate.assert_fixed_listener_bind(8776, authorized=True)
                with self.assertRaises(RuntimeError):
                    gate.assert_fixed_listener_bind(8765, authorized=True)
            finally:
                gate.EXACT_PORT_LISTENER_ENABLED = False
        finally:
            supervisor.close_supervisor_handles()
            import shutil
            shutil.rmtree(sessions.parent, ignore_errors=True)
        after = listening()
        self.assertNotIn(8776, after)
        self.assertEqual(before.get(8765), after.get(8765))
        self.assertEqual(before.get(7860), after.get(7860))


class PageProcess(unittest.TestCase):
    def test_python313_identity_generation_and_cleanup(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        identity_path = root / "identity.json"
        stop_flag = root / "stop.flag"
        origin_file = root / "origin.txt"
        stderr_path = root / "stderr.txt"
        stderr_handle = stderr_path.open("wb", buffering=0)
        process = subprocess.Popen(
            [str(PYTHON), str(SOURCE / "tests" / "m2b_exact_port_page.py"), "--ephemeral", str(identity_path), str(stop_flag), str(origin_file)],
            cwd=str(SOURCE),
            stderr=stderr_handle,
        )
        try:
            try:
                identity = publication.wait_until_ready(
                    identity_path,
                    publication.parse_json_record,
                    process,
                    20,
                    stderr_path,
                )
            except publication.PublicationError as exc:
                self.fail(f"page publication {exc.code} exit={exc.returncode} stderr={exc.stderr[:500]}")
            self.assertEqual(str(identity["executable"]).casefold(), str(PYTHON).casefold())
            self.assertEqual(str(identity["script"]).casefold(), str((SOURCE / "tests" / "m2b_exact_port_page.py").resolve()).casefold())
            self.assertEqual(identity["pid"], process.pid)
            self.assertEqual(identity["creation"], life.process_creation(process.pid))
            self.assertNotIn(identity["port"], gate.RESERVED_PORTS)
            self.assertNotIn(Path(r"C:\Transfert").resolve(), Path(identity["sessions"]).resolve().parents)
            self.assertIsInstance(identity["generation"], int)
            self.assertNotIn(PIN, identity_path.read_text(encoding="utf-8"))
            self.assertTrue(life.process_alive(process.pid))
        finally:
            stop_flag.write_text("stop\n", encoding="ascii")
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            stderr_handle.close()
            import shutil
            shutil.rmtree(root, ignore_errors=True)
        self.assertFalse(life.process_alive(process.pid))


class Boundaries(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config_path = SOURCE / "bridge_config.json"
        cls.config_existed = cls.config_path.is_file()
        cls.config_before = cls.config_path.read_bytes() if cls.config_existed else None
        import iphone_bridge as bridge
        cls.bridge = bridge

    @classmethod
    def tearDownClass(cls) -> None:
        cls.bridge.SESSIONS_PATH = SOURCE / "bridge_sessions.json"
        cls.bridge._SESSIONS.clear()
        if not cls.config_existed and cls.config_path.is_file() and cls.config_path.parent == SOURCE:
            cls.config_path.unlink()
        elif cls.config_before is not None and cls.config_path.is_file() and cls.config_path.read_bytes() != cls.config_before:
            cls.config_path.write_bytes(cls.config_before)

    def tearDown(self) -> None:
        gate.reset_browser_binding_for_tests()

    def test_admin_role_csrf_origin_and_csp(self) -> None:
        self.assertIn("connect-src 'self' http://127.0.0.1:8776", gate.content_security_policy("127.0.0.1:8765", "/lifecycle-probe"))
        for host in ("192.168.1.20:8765", "vieuxpeepee.taila4d470.ts.net", "localhost:8765"):
            self.assertNotIn("8776", gate.content_security_policy(host, "/lifecycle-probe"))
        root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        sessions = root / "bridge_sessions.json"
        self.bridge.SESSIONS_PATH = sessions
        self.bridge._SESSIONS.clear()
        self.bridge.CONFIG["pin"] = PIN
        self.bridge.CONFIG["users"] = []
        generation = self.bridge.auth_generation()
        supervisor = life.Supervisor(root, f"Local\\TransfertHQ-M1-{uuid.uuid4().hex[:8]}", f"Local\\TransfertHQ-M1-Mutex-{uuid.uuid4().hex[:8]}")
        listener = None
        try:
            self.assertEqual(gate.classify_persisted_session(sessions, "missing", generation), "anonymous")
            sessions.write_text(json.dumps({
                "operator": {"exp": time.time() + 3600, "user": "admin", "role": "operator", "gen": generation},
                "admin-live": {"exp": time.time() + 3600, "user": "admin", "role": "admin", "gen": generation},
            }), encoding="utf-8")
            before = sessions.read_bytes()
            self.assertEqual(gate.classify_persisted_session(sessions, "operator", generation), "forbidden")
            life.reload_persisted_sessions(self.bridge)
            self.assertEqual(self.bridge.session_role("operator"), "")
            self.assertEqual(sessions.read_bytes(), before)
            creation = life.process_creation(os.getpid())
            listener = gate.LifecycleListener(
                supervisor, "http://127.0.0.1:9100", sessions, generation, os.getpid(), int(creation or 0), lambda: "ready"
            )
            self.assertNotIn(listener.port, gate.RESERVED_PORTS)
            token = "admin-live"
            credential = gate.mint_csrf_for_session(sessions, token)
            self.assertEqual(sessions.read_bytes(), before)

            def post(origin: str, *, csrf: str | None = credential, host: str | None = None) -> tuple[int, str]:
                headers = {"Origin": origin, "Content-Type": "application/json", "Cookie": f"transfert_session={token}"}
                if csrf is not None:
                    headers[gate.CSRF_HEADER] = csrf
                if host is not None:
                    headers["Host"] = host
                request = Request(
                    f"http://127.0.0.1:{listener.port}/lifecycle/start",
                    data=b"{}",
                    method="POST",
                    headers=headers,
                )
                try:
                    with urlopen(request, timeout=10) as response:
                        return response.status, str(response.headers)
                except HTTPError as exc:
                    return exc.code, str(exc.headers)

            allowed, allowed_headers = post("http://127.0.0.1:9100")
            self.assertEqual(allowed, 200)
            self.assertIn("http://127.0.0.1:9100", allowed_headers)
            self.assertNotIn("*", allowed_headers)
            missing, _headers = post("http://127.0.0.1:9100", csrf=None)
            self.assertEqual(missing, 403)
            foreign, foreign_headers = post("https://vieuxpeepee.taila4d470.ts.net")
            self.assertEqual(foreign, 403)
            self.assertNotIn("Access-Control-Allow-Origin", foreign_headers)
            lan, _lan_headers = post("http://192.168.2.22:8765")
            self.assertEqual(lan, 403)
            mismatched, _host_headers = post("http://127.0.0.1:9100", host="192.168.2.22:8765")
            self.assertEqual(mismatched, 403)
            self.assertEqual(sessions.read_bytes(), before)
            self.assertNotIn(credential, json.dumps(listener.calls))
            self.assertNotIn(token, json.dumps(listener.calls))
            record = json.loads((root / "lifecycle.json").read_text(encoding="utf-8"))
            outcome = life.harness_stop(int(record["pid"]), int(record["creation"]), "cmd.exe")
            self.assertIn(outcome, {"stopped-by-harness", "already-gone"})
            self.assertFalse(life.process_alive(int(record["pid"])))
        finally:
            if listener is not None:
                listener.close()
            supervisor.terminate_if_proven()
            supervisor.close_supervisor_handles()
            import shutil
            shutil.rmtree(root, ignore_errors=True)


class Recovery(unittest.TestCase):
    def test_missing_malformed_stale_and_inconsistent_records(self) -> None:
        missing_root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        missing = missing_root / "window-state.json"
        try:
            with self.assertRaises(recovery.RecoveryError) as absent:
                recovery.load_state(missing, now=NOW)
            self.assertEqual(absent.exception.code, "absent")
        finally:
            import shutil
            shutil.rmtree(missing_root, ignore_errors=True)
        with self.assertRaises(recovery.RecoveryError):
            recovery.write_state(Path(r"C:\Transfert\window-state.json"), payload_for("ports-free"), now=NOW)
        self.assertFalse(Path(r"C:\Transfert\window-state.json").exists())
        stale = payload_for("ports-free")
        stale["written_at"] = NOW - recovery.MAX_AGE_SEC - 1
        with self.assertRaises(recovery.RecoveryError) as stale_error:
            recovery.validate_payload(stale, now=NOW)
        self.assertEqual(stale_error.exception.code, "stale")
        future = payload_for("ports-free")
        future["written_at"] = NOW + 301
        with self.assertRaises(recovery.RecoveryError) as future_error:
            recovery.validate_payload(future, now=NOW)
        self.assertEqual(future_error.exception.code, "inconsistent")
        broken = payload_for("test-running")
        broken["listener"] = None
        with self.assertRaises(recovery.RecoveryError) as inconsistent:
            recovery.validate_payload(broken, now=NOW)
        self.assertEqual(inconsistent.exception.code, "inconsistent")
        commanded = payload_for("ports-free")
        commanded["launch"] = HQ_COMMAND
        with self.assertRaises(recovery.RecoveryError) as malformed:
            recovery.validate_payload(commanded, now=NOW)
        self.assertEqual(malformed.exception.code, "malformed")
        authorized = payload_for("ports-free")
        authorized["maintenance_authorized"] = True
        with self.assertRaises(recovery.RecoveryError) as rejected:
            recovery.validate_payload(authorized, now=NOW)
        self.assertEqual(rejected.exception.code, "inconsistent")

    def test_tamper_and_unauthorized_dacl(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        path = root / "window-state.json"
        try:
            recovery.write_state(path, payload_for("ports-free"), now=NOW)
            loaded = recovery.load_state(path, now=NOW)
            self.assertEqual(loaded["phase"], "ports-free")
            original = path.read_bytes()
            path.write_bytes(original.replace(b"ports-free", b"restored!!"))
            with self.assertRaises(recovery.RecoveryError) as tampered:
                recovery.load_state(path, now=NOW)
            self.assertEqual(tampered.exception.code, "malformed")
            path.write_bytes(original)
            completed = subprocess.run(
                ["icacls", str(path), "/grant", "*S-1-1-0:(F)"],
                check=False,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(completed.returncode, 0)
            with self.assertRaises(recovery.RecoveryError) as unauthorized:
                recovery.load_state(path, now=NOW)
            self.assertEqual(unauthorized.exception.code, "unauthorized")
        finally:
            subprocess.run(["icacls", str(path), "/grant", f"*{recovery.current_user_sid()}:(F)"], check=False, capture_output=True)
            import shutil
            shutil.rmtree(root, ignore_errors=True)

    def test_identity_mismatch_and_interrupted_stages(self) -> None:
        stages = {
            "serve-paused": "restore-serve",
            "hq-stopped": "start-hq",
            "test-running": "stop-listener",
            "listener-down": "stop-page",
            "ports-free": "start-hq",
            "hq-verified": "restore-serve",
            "restored": "none",
        }
        for phase, expected in stages.items():
            body = payload_for(phase)
            plan = recovery.build_plan(body, live_from(body), observer_for(body), serve_bytes=SERVE_BYTES)
            self.assertEqual(plan["next"], expected, phase)
            self.assertFalse(plan["performed"])
            if phase in {"test-running", "listener-down"}:
                self.assertFalse(plan["restore_serve"])
                self.assertNotEqual(plan["stop"]["pid"], body["forge"]["pid"])
            if phase in {"serve-paused", "hq-verified", "restored"}:
                self.assertIsNone(plan["stop"])
            if plan["command"] is not None:
                self.assertNotIn("reset", plan["command"])
                self.assertNotIn("funnel", plan["command"])
                if expected == "start-hq":
                    self.assertEqual(tuple(plan["command"]), recovery.HQ_LAUNCH)
                if expected == "restore-serve":
                    self.assertEqual(tuple(plan["command"]), recovery.SERVE_RESTORE)
        again = recovery.build_plan(payload_for("restored"), live_from(payload_for("restored")), observer_for(payload_for("restored")), serve_bytes=SERVE_BYTES)
        self.assertEqual(again["next"], "none")
        self.assertIsNone(again["command"])

    def test_pid_reuse_replacement_and_serve_hold(self) -> None:
        body = payload_for("test-running")
        calls = {"n": 0}

        def flipping(pid: int):
            calls["n"] += 1
            record = observed(body["listener"] if pid == body["listener"]["pid"] else body["test_page"])
            if calls["n"] >= 2:
                record = dict(record)
                record["creation"] = record["creation"] + 1
            return record

        plan = recovery.build_plan(body, live_from(body), flipping, serve_bytes=SERVE_BYTES)
        self.assertEqual(plan["next"], "blocked")
        self.assertFalse(plan["restore_serve"])
        replaced = live_from(body)
        replaced["8776"] = observed(body["listener"], [recovery.PYTHON_EXE, r"C:\not-the-listener.py"])
        blocked = recovery.build_plan(body, replaced, observer_for(body), serve_bytes=SERVE_BYTES)
        self.assertEqual(blocked["next"], "blocked")
        self.assertFalse(blocked["restore_serve"])
        body_down = payload_for("listener-down")
        mismatched = live_from(body_down)
        mismatched["8765"]["executable"] = r"C:\Windows\System32\notepad.exe"
        mismatched["8765"]["argv"] = [r"C:\Windows\System32\notepad.exe", recovery.PAGE_SCRIPT]
        refused = recovery.build_plan(body_down, mismatched, observer_for(body_down), serve_bytes=SERVE_BYTES)
        self.assertEqual(refused["next"], "blocked")
        self.assertFalse(refused["restore_serve"])

    def test_dry_run_is_idempotent_and_does_not_stop_hq_or_forge(self) -> None:
        root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        path = root / "window-state.json"
        before = listening()
        try:
            body = payload_for("test-running")
            recovery.write_state(path, body, now=NOW)
            first = recovery.recover(path, live_from(body), observer_for(body), now=NOW, serve_bytes=SERVE_BYTES, dry_run=True)
            second = recovery.recover(path, live_from(body), observer_for(body), now=NOW, serve_bytes=SERVE_BYTES, dry_run=True)
            self.assertEqual(first, second)
            self.assertEqual(first["next"], "stop-listener")
            self.assertFalse(first["performed"])
            self.assertFalse(first["restore_serve"])
            forced = recovery.recover(path, live_from(body), observer_for(body), now=NOW, serve_bytes=SERVE_BYTES, dry_run=False)
            self.assertEqual(forced["next"], "blocked")
            self.assertFalse(forced["restore_serve"])
            calls = []

            def observe(pid: int):
                calls.append(pid)
                return None

            with self.assertRaises(recovery.RecoveryError) as disabled:
                recovery.commit_stop(body["test_page"], observe)
            self.assertEqual(disabled.exception.code, "disabled")
            self.assertEqual(calls, [])
            with self.assertRaises(recovery.RecoveryError):
                recovery.commit_launch(recovery.HQ_LAUNCH)
            with self.assertRaises(recovery.RecoveryError):
                recovery.commit_serve(recovery.SERVE_RESTORE)
            recovery.MAINTENANCE_RECOVERY_ENABLED = True
            try:
                with self.assertRaises(recovery.RecoveryError) as production_stop:
                    recovery.commit_stop(hq_record(), observer_for(payload_for("serve-paused")))
                self.assertEqual(production_stop.exception.code, "blocked")
                with self.assertRaises(recovery.RecoveryError) as forge_stop:
                    recovery.commit_stop(forge_record(), observer_for(body))
                self.assertEqual(forge_stop.exception.code, "blocked")
            finally:
                recovery.MAINTENANCE_RECOVERY_ENABLED = False
            self.assertEqual(recovery.main(["--apply"]), 2)
            self.assertEqual(recovery.main(["--dry-run"]), 2)
            live = recovery.collect_ports()
            live_plan = recovery.build_plan(body, live, recovery.live_observer, serve_bytes=None)
            self.assertFalse(live_plan["performed"])
            self.assertFalse(live_plan["restore_serve"])
            self.assertIsNone(live_plan["stop"])
            self.assertNotIn(live_plan["next"], {"stop-page", "stop-listener"})
        finally:
            recovery.MAINTENANCE_RECOVERY_ENABLED = False
            import shutil
            shutil.rmtree(root, ignore_errors=True)
        after = listening()
        for port in (7860, 8765, 8766, 8776):
            self.assertEqual(before.get(port), after.get(port), port)


HQ_COMMAND = r"C:\Windows\System32\cmd.exe /c whoami"
WRITER = (
    "import sys\n"
    "from pathlib import Path\n"
    "sys.path.insert(0, sys.argv[1])\n"
    "import hq_forge_exact_port_recovery as recovery\n"
    "recovery.write_observed_pause(Path(sys.argv[2]), Path(sys.argv[3]))\n"
)


def serve_status() -> str:
    completed = subprocess.run(
        ["tailscale", "serve", "status"],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    return completed.stdout


def run_cli(root: Path, state: Path, serve: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(SOURCE / "hq_forge_exact_port_recovery.py"),
            "--dry-run",
            "--state",
            str(state),
            "--serve",
            str(serve),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        cwd=str(root),
    )


class RecoveryCli(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        self.state = self.root / "window-state.json"
        self.serve = self.root / "serve-snapshot.json"
        self.ports = listening()
        self.serve_text = serve_status()

    def tearDown(self) -> None:
        recovery.release_disposable(self.root)
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)
        after = listening()
        for port in (7860, 8765, 8766, 8776):
            self.assertEqual(self.ports.get(port), after.get(port), port)
        self.assertEqual(serve_status(), self.serve_text)

    def test_separate_process_repeats_a_live_dry_run(self) -> None:
        writer = subprocess.run(
            [sys.executable, "-c", WRITER, str(SOURCE), str(self.state), str(self.serve)],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(writer.returncode, 0, writer.stderr)
        first = run_cli(self.root, self.state, self.serve)
        second = run_cli(self.root, self.state, self.serve)
        self.assertEqual(first.returncode, 0, first.stderr + first.stdout)
        self.assertEqual(second.returncode, 0, second.stderr + second.stdout)
        self.assertEqual(first.stdout, second.stdout)
        plan = json.loads(first.stdout)
        self.assertEqual(plan["next"], "restore-serve")
        self.assertFalse(plan["performed"])
        self.assertFalse(plan["executed"])
        self.assertTrue(plan["restore_serve"])
        self.assertEqual(plan["command"], list(recovery.SERVE_RESTORE))
        self.assertNotIn("reset", plan["command"])
        self.assertNotIn("funnel", plan["command"])

    def test_stale_corrupt_unauthorized_and_interrupted_exit_nonzero(self) -> None:
        now = int(time.time())
        body = payload_for("ports-free")
        body["written_at"] = now
        recovery.write_serve_file(self.serve)
        recovery.write_state(self.state, body, now=now)
        planted = json.loads(self.state.read_text(encoding="ascii"))
        planted["payload"]["written_at"] = now - recovery.MAX_AGE_SEC - 30
        planted["checksum"] = hashlib.sha256(recovery.canonical_payload(planted["payload"])).hexdigest()
        self.state.write_text(json.dumps(planted, sort_keys=True) + "\n", encoding="ascii")
        stale = run_cli(self.root, self.state, self.serve)
        self.assertEqual(stale.returncode, 3)
        self.assertIn("stale", stale.stderr)
        self.assertFalse(json.loads(stale.stdout)["restore_serve"])

        fresh = payload_for("ports-free")
        fresh["written_at"] = now
        self.state.write_text(json.dumps(recovery.checksum_wrapper(fresh), sort_keys=True) + "\n", encoding="ascii")
        raw = bytearray(self.state.read_bytes())
        raw[-4] ^= 0x01
        self.state.write_bytes(raw)
        corrupt = run_cli(self.root, self.state, self.serve)
        self.assertEqual(corrupt.returncode, 3)
        self.assertIn("malformed", corrupt.stderr)

        self.state.write_text(json.dumps(recovery.checksum_wrapper(fresh), sort_keys=True) + "\n", encoding="ascii")
        granted = subprocess.run(
            ["icacls", str(self.state), "/grant", "*S-1-1-0:(R)"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(granted.returncode, 0, granted.stderr)
        unauthorized = run_cli(self.root, self.state, self.serve)
        self.assertEqual(unauthorized.returncode, 3)
        self.assertIn("unauthorized", unauthorized.stderr)

        recovery.release_disposable(self.root)
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)
        self.root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))
        self.state = self.root / "window-state.json"
        self.serve = self.root / "serve-snapshot.json"
        interrupted_body = payload_for("test-running")
        interrupted_body["written_at"] = now
        recovery.write_serve_file(self.serve)
        recovery.write_state(self.state, interrupted_body, now=now)
        interrupted = run_cli(self.root, self.state, self.serve)
        self.assertEqual(interrupted.returncode, 3, interrupted.stdout)
        plan = json.loads(interrupted.stdout)
        self.assertEqual(plan["next"], "blocked")
        self.assertFalse(plan["restore_serve"])
        self.assertIsNone(plan["command"])
        self.assertIn("will not be stopped", plan["report"])

    def test_parent_directory_acl_is_required(self) -> None:
        now = int(time.time())
        body = payload_for("ports-free")
        body["written_at"] = now
        recovery.write_state(self.state, body, now=now)
        granted = subprocess.run(
            ["icacls", str(self.root), "/grant", "*S-1-1-0:(R)"],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        self.assertEqual(granted.returncode, 0, granted.stderr)
        with self.assertRaises(recovery.RecoveryError) as caught:
            recovery.load_state(self.state, now=now)
        self.assertEqual(caught.exception.code, "unauthorized")


class _Alive:
    def poll(self):
        return None


class Publication(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="m2b-exact-"))

    def tearDown(self) -> None:
        import shutil
        shutil.rmtree(self.root, ignore_errors=True)

    def test_delayed_publication_waits_for_the_complete_port(self) -> None:
        path = self.root / "port.txt"
        helper = Path(__file__).with_name("m2b_publication.py")
        stderr_path = self.root / "stderr.txt"
        stderr_handle = stderr_path.open("wb", buffering=0)
        process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                "import importlib.util,sys,time; from pathlib import Path; time.sleep(float(sys.argv[1])); spec=importlib.util.spec_from_file_location('m2b_publication', sys.argv[2]); module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); module.publish_port(Path(sys.argv[3]), int(sys.argv[4]))",
                "0.4",
                str(helper),
                str(path),
                "34567",
            ],
            stderr=stderr_handle,
        )
        started = time.monotonic()
        try:
            port = publication.wait_until_ready(path, publication.parse_port, process, 3, stderr_path)
        finally:
            process.wait(timeout=5)
            stderr_handle.close()
        self.assertEqual(port, 34567)
        self.assertGreaterEqual(time.monotonic() - started, 0.3)
        self.assertIsNone(publication.parse_port(b"34567"))
        self.assertEqual(publication.parse_port(path.read_bytes()), 34567)

    def test_partial_file_is_not_ready(self) -> None:
        path = self.root / "port.txt"
        path.write_bytes(b"3456")
        self.assertIsNone(publication.parse_port(path.read_bytes()))
        started = time.monotonic()
        with self.assertRaises(publication.PublicationError) as caught:
            publication.wait_until_ready(path, publication.parse_port, _Alive(), 0.2)
        self.assertEqual(caught.exception.code, "timeout")
        self.assertLess(time.monotonic() - started, 1)
        self.assertFalse(path.read_bytes().endswith(b"\n"))

    def test_malformed_records_fail_before_the_timeout(self) -> None:
        cases = [
            (self.root / "port.txt", b"nope\n", publication.parse_port),
            (self.root / "zero.txt", b"0\n", publication.parse_port),
            (self.root / "wide.txt", b"65536\n", publication.parse_port),
            (self.root / "record.json", b"[]\n", publication.parse_json_record),
            (self.root / "pair.json", b'{"a":1}\n{"b":2}\n', publication.parse_json_record),
            (self.root / "origin.txt", b"http://10.0.0.1:80\n", publication.parse_origin),
        ]
        for path, raw, parser in cases:
            path.write_bytes(raw)
            started = time.monotonic()
            with self.assertRaises(publication.PublicationError) as caught:
                publication.wait_until_ready(path, parser, _Alive(), 5)
            self.assertEqual(caught.exception.code, "malformed", raw)
            self.assertLess(time.monotonic() - started, 0.5)
        self.assertIsNone(publication.parse_json_record(b'{"port":1'))
        self.assertIsNone(publication.parse_origin(b"http://127.0.0.1:80"))

    def test_early_process_exit_reports_status_and_stderr(self) -> None:
        path = self.root / "port.txt"
        stderr_path = self.root / "stderr.txt"
        stderr_handle = stderr_path.open("wb", buffering=0)
        process = subprocess.Popen(
            [sys.executable, "-c", "import sys; sys.stderr.write('boom\\n'); raise SystemExit(7)"],
            stderr=stderr_handle,
        )
        started = time.monotonic()
        try:
            with self.assertRaises(publication.PublicationError) as caught:
                publication.wait_until_ready(path, publication.parse_port, process, 5, stderr_path)
        finally:
            process.wait(timeout=5)
            stderr_handle.close()
        self.assertEqual(caught.exception.code, "exited")
        self.assertEqual(caught.exception.returncode, 7)
        self.assertIn("boom", caught.exception.stderr)
        self.assertLess(time.monotonic() - started, 2)
        self.assertFalse(path.exists())

    def test_concurrent_publishers_yield_complete_records(self) -> None:
        helper = Path(__file__).with_name("m2b_publication.py")
        code = (
            "import importlib.util,sys; from pathlib import Path; "
            "spec=importlib.util.spec_from_file_location('m2b_publication', sys.argv[1]); "
            "module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); "
            "module.publish_port(Path(sys.argv[2]), int(sys.argv[4])); "
            "module.publish_json(Path(sys.argv[3]), {'port': int(sys.argv[4])})"
        )
        processes = []
        expected = {}
        for port in (18111, 18112, 18113, 18114):
            port_path = self.root / f"{port}.port"
            record_path = self.root / f"{port}.json"
            stderr_path = self.root / f"{port}.stderr"
            stderr_handle = stderr_path.open("wb", buffering=0)
            process = subprocess.Popen(
                [sys.executable, "-c", code, str(helper), str(port_path), str(record_path), str(port)],
                stderr=stderr_handle,
            )
            processes.append((process, stderr_handle, port_path, record_path, stderr_path, port))
            expected[port] = port
        try:
            for process, _handle, port_path, record_path, stderr_path, port in processes:
                found = publication.wait_until_ready(port_path, publication.parse_port, process, 5, stderr_path)
                record = publication.wait_until_ready(record_path, publication.parse_json_record, process, 5, stderr_path)
                self.assertEqual(found, port)
                self.assertEqual(record, {"port": port})
        finally:
            for process, handle, *_rest in processes:
                process.wait(timeout=5)
                handle.close()
        names = sorted(item.name for item in self.root.iterdir())
        self.assertEqual(names, sorted(f"{port}.{suffix}" for port in expected for suffix in ("json", "port", "stderr")))

    def test_replace_publication_does_not_expose_a_partial_record(self) -> None:
        path = self.root / "port.txt"
        seen: list[object] = []
        stop = threading.Event()

        def read() -> None:
            while not stop.is_set():
                if not path.is_file():
                    continue
                try:
                    raw = path.read_bytes()
                except OSError:
                    continue
                try:
                    value = publication.parse_port(raw)
                except publication.PublicationError:
                    seen.append("malformed")
                    return
                if value is None:
                    seen.append("partial")
                    return
                seen.append(value)

        reader = threading.Thread(target=read, daemon=True)
        reader.start()
        try:
            for port in range(21000, 21100):
                publication.publish_port(path, port)
        finally:
            stop.set()
            reader.join(timeout=2)
        self.assertFalse(reader.is_alive())
        self.assertNotIn("partial", seen)
        self.assertNotIn("malformed", seen)
        self.assertTrue(seen)
        self.assertTrue(all(21000 <= item <= 21099 for item in seen))
        self.assertEqual(publication.parse_port(path.read_bytes()), 21099)
        self.assertEqual([item.name for item in self.root.iterdir()], ["port.txt"])


if __name__ == "__main__":
    unittest.main()
