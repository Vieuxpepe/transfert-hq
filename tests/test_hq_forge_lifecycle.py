"""M1 sleeper supervisor. These tests do not launch Forge or bind port 7860."""

from __future__ import annotations

import json
import os
import socket
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

import hq_forge_lifecycle as life  # noqa: E402

EVIDENCE: list[dict] = []
ORPHANS: list[dict] = []
FORGE_PID_BEFORE: int | None = None
CREATE_NO_WINDOW = 0x08000000


def forge_listener_pid() -> int | None:
    output = subprocess.check_output(["netstat", "-ano", "-p", "tcp"], text=True, encoding="utf-8", errors="replace")
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].startswith("127.0.0.1:7860") and parts[3] == "LISTENING":
            return int(parts[4])
    return None


def note(test: str, **facts) -> None:
    EVIDENCE.append({"test": test, **facts})


def outside_ping() -> tuple[subprocess.Popen, int]:
    ping = str(Path(life.system_directory()) / "PING.EXE")
    proc = subprocess.Popen(
        [ping, "-n", "25", "127.0.0.1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        creationflags=CREATE_NO_WINDOW,
    )
    creation = life.process_creation(proc.pid)
    if creation is None:
        proc.kill()
        raise RuntimeError("outside ping has no creation time")
    return proc, creation


class SupervisorCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.nonce = uuid.uuid4().hex[:12]
        self.tracked: list[tuple[int, int, str]] = []
        self.supervisor = self.make()

    def make(self, **kwargs) -> life.Supervisor:
        return life.Supervisor(
            Path(self.tmp.name),
            f"Local\\TransfertHQ-M1-{self.nonce}",
            f"Local\\TransfertHQ-M1-Mutex-{self.nonce}",
            **kwargs,
        )

    def track_members(self) -> None:
        path = Path(self.tmp.name) / "lifecycle.json"
        if not path.is_file():
            return
        record = json.loads(path.read_text(encoding="utf-8"))
        items = list(record.get("members") or [])
        if "pid" in record and "creation" in record:
            items.append({
                "pid": record["pid"],
                "creation": record["creation"],
                "image": record.get("image") or "",
            })
        seen = {(pid, creation) for pid, creation, _suffix in self.tracked}
        for item in items:
            key = (int(item["pid"]), int(item["creation"]))
            if key in seen:
                continue
            image = str(item.get("image") or "").lower()
            if image.endswith("\\ping.exe"):
                suffix = "PING.EXE"
            elif image.endswith("\\cmd.exe"):
                suffix = "cmd.exe"
            elif image.endswith("\\conhost.exe"):
                suffix = "conhost.exe"
            else:
                continue
            seen.add(key)
            self.track(key[0], key[1], suffix)

    def track(self, pid: int, creation: int, suffix: str) -> None:
        self.tracked.append((pid, creation, suffix))

    def tearDown(self) -> None:
        try:
            self.supervisor.terminate_if_proven()
        except Exception:
            pass
        self.supervisor.close_supervisor_handles()
        for pid, creation, suffix in self.tracked:
            outcome = life.harness_stop(pid, creation, suffix)
            if outcome not in {"stopped-by-harness", "already-gone"}:
                ORPHANS.append({"pid": pid, "creation": creation, "suffix": suffix, "outcome": outcome})
        outside = getattr(self, "_outside", None)
        if outside is not None:
            outside.poll()
            if outside.returncode is None:
                try:
                    outside.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    ORPHANS.append({"pid": outside.pid, "outcome": "outside-ping-still-running"})
        self.tmp.cleanup()

    def test_product_command_is_not_launchable(self) -> None:
        self.assertFalse(life.FORGE_LAUNCH_ENABLED)
        self.assertFalse(life.PRODUCT_LISTENER_ENABLED)
        self.assertIn("webui.bat", life.FORGE_COMMAND)
        self.assertIn("--api", life.FORGE_COMMAND)
        result = self.supervisor.start_product()
        self.assertEqual(result["code"], "forge_disabled")
        self.assertFalse(result["signaled"])
        self.assertNotIn("create_process_suspended", self.supervisor.events)
        with self.assertRaises(RuntimeError):
            life.Supervisor(Path(self.tmp.name), life.PRODUCT_JOB_NAME, life.PRODUCT_MUTEX_NAME)

    def test_reopen_after_supervisor_drops_its_handle(self) -> None:
        started = self.supervisor.start()
        self.assertTrue(started["ok"], started)
        self.track_members()
        self.assertTrue(life.process_alive(started["pid"]))
        self.supervisor.close_supervisor_handles()
        again = self.make()
        recovered = again.recover()
        self.assertTrue(recovered["ok"], recovered)
        self.assertEqual(recovered["pid"], started["pid"])
        self.assertEqual(recovered["creation"], started["creation"])
        self.assertEqual(life.process_creation(started["pid"]), started["creation"])
        self.assertNotIn("create_process_suspended", again.events)
        self.assertNotIn("terminate_job", again.events)
        note(
            "reopen",
            pid=started["pid"],
            creation=started["creation"],
            image=started["image"],
            alive=life.process_alive(started["pid"]),
        )
        again.terminate_if_proven()

    def test_missing_record_leaves_the_process_alive(self) -> None:
        started = self.supervisor.start()
        self.track_members()
        (Path(self.tmp.name) / "lifecycle.json").unlink()
        again = self.make()
        recovered = again.recover()
        self.assertEqual(recovered["state"], "unmanaged")
        self.assertFalse(recovered["signaled"])
        self.assertIn("terminate_job:no", again.events)
        self.assertNotIn("terminate_job", again.events)
        self.assertTrue(life.process_alive(started["pid"]))
        self.assertEqual(life.process_creation(started["pid"]), started["creation"])
        note("missing-record", pid=started["pid"], creation=started["creation"], alive=True)

    def test_wrong_creation_time_leaves_the_process_alive(self) -> None:
        started = self.supervisor.start()
        self.track_members()
        self._tamper(creation=started["creation"] + 1)
        stopped = self.supervisor.terminate_if_proven()
        self.assertFalse(stopped["signaled"])
        self.assertNotIn("terminate_job", self.supervisor.events)
        self.assertTrue(life.process_alive(started["pid"]))
        self.assertEqual(life.process_creation(started["pid"]), started["creation"])
        note("wrong-creation", pid=started["pid"], creation=started["creation"], alive=True)

    def test_wrong_executable_leaves_the_process_alive(self) -> None:
        started = self.supervisor.start()
        self.track_members()
        self._tamper(image=str(Path(life.system_directory()) / "notepad.exe"))
        stopped = self.supervisor.terminate_if_proven()
        self.assertFalse(stopped["signaled"])
        self.assertNotIn("terminate_job", self.supervisor.events)
        self.assertTrue(life.process_alive(started["pid"]))
        note("wrong-executable", pid=started["pid"], creation=started["creation"], alive=True)

    def test_process_outside_the_job_is_not_a_member(self) -> None:
        started = self.supervisor.start()
        self.track_members()
        empty_name = f"Local\\TransfertHQ-M1-empty-{self.nonce}"
        held = life.retain_empty_job(empty_name)
        try:
            other = life.Supervisor(
                Path(self.tmp.name),
                empty_name,
                f"Local\\TransfertHQ-M1-Mutex-empty-{self.nonce}",
            )
            stopped = other.terminate_if_proven()
            self.assertFalse(stopped["signaled"])
            self.assertIn("membership_rejected", other.events)
            self.assertNotIn("terminate_job", other.events)
            self.assertTrue(life.process_alive(started["pid"]))
            note("not-a-member", pid=started["pid"], creation=started["creation"], alive=True)
        finally:
            life.release_handle(held)

    def test_stale_pid_does_not_kill_an_unrelated_process(self) -> None:
        proc, creation = outside_ping()
        self._outside = proc
        self.track(proc.pid, creation, "PING.EXE")
        payload = {
            "version": 1,
            "state": "ready",
            "restart_pending": False,
            "job_name": self.supervisor.job_name,
            "pid": proc.pid,
            "creation": creation + 1,
            "image": str(Path(life.system_directory()) / "cmd.exe"),
            "members": [{"pid": proc.pid, "creation": creation + 1, "image": "C:\\Windows\\System32\\cmd.exe"}],
        }
        (Path(self.tmp.name) / "lifecycle.json").write_text(json.dumps(payload), encoding="utf-8")
        stopped = self.supervisor.terminate_if_proven()
        self.assertFalse(stopped["signaled"])
        self.assertNotIn("terminate_job", self.supervisor.events)
        self.assertTrue(life.process_alive(proc.pid))
        self.assertEqual(life.process_creation(proc.pid), creation)
        note("stale-pid", pid=proc.pid, creation=creation, alive=True)

    def test_lost_job_name_is_unmanaged_and_not_adopted(self) -> None:
        blind = self.make(retain_handle=False)
        started = blind.start()
        self.assertTrue(started["ok"], started)
        self.track_members()
        self.assertTrue(life.process_alive(started["pid"]))
        blind.close_supervisor_handles()
        again = self.make(retain_handle=False)
        recovered = again.recover()
        self.assertEqual(recovered["code"], "unmanaged")
        self.assertTrue(any(event.startswith("open_failed:") for event in again.events))
        self.assertIn("create_job_on_recover:no", again.events)
        self.assertNotIn("terminate_job", again.events)
        self.assertNotIn("create_job", again.events)
        self.assertTrue(life.process_alive(started["pid"]))
        refused = again.start()
        self.assertFalse(refused["ok"])
        self.assertNotIn("create_process_suspended", again.events)
        note("lost-name", pid=started["pid"], creation=started["creation"], alive=True)

    def test_command_exit_leaves_descendant_unmanaged(self) -> None:
        detached = self.make(kind="detach")
        started = detached.start()
        self.assertTrue(started["ok"], detached.events)
        record = json.loads((Path(self.tmp.name) / "lifecycle.json").read_text(encoding="utf-8"))
        descendants = [
            item for item in record["members"]
            if item["pid"] != started["pid"] and str(item["image"]).lower().endswith("ping.exe")
        ]
        self.assertTrue(descendants, record["members"])
        child = descendants[0]
        self.track_members()
        self.assertFalse(life.process_alive(started["pid"]))
        detached.close_supervisor_handles()
        again = self.make(kind="detach")
        recovered = again.recover()
        self.assertEqual(recovered["state"], "unmanaged", again.events)
        self.assertNotIn("terminate_job", again.events)
        self.assertIn("create_job_on_recover:no", again.events)
        self.assertTrue(life.process_alive(child["pid"]))
        self.assertEqual(life.process_creation(child["pid"]), child["creation"])
        refused = again.start()
        self.assertNotIn("create_process_suspended", again.events)
        self.assertFalse(refused["ok"])
        note(
            "descendant-unmanaged",
            root_pid=started["pid"],
            root_creation=started["creation"],
            descendant_pid=child["pid"],
            descendant_creation=child["creation"],
            descendant_alive=True,
        )

    def test_occupant_blocks_start_without_termination(self) -> None:
        proc, creation = outside_ping()
        self._outside = proc
        self.track(proc.pid, creation, "PING.EXE")
        blocked = self.make(occupant=lambda: True)
        result = blocked.start()
        self.assertEqual(result["code"], "unmanaged")
        self.assertFalse(result["signaled"])
        self.assertNotIn("terminate_job", blocked.events)
        self.assertNotIn("create_process_suspended", blocked.events)
        self.assertTrue(life.process_alive(proc.pid))
        self.assertEqual(life.process_creation(proc.pid), creation)
        note("occupant", pid=proc.pid, creation=creation, alive=True)

    def test_concurrent_starts_spawn_once(self) -> None:
        gate = threading.Event()
        first = self.make()
        second = self.make()
        first.on_locked = gate.set
        results: dict[str, dict] = {}

        def run_first() -> None:
            results["first"] = first.start()

        thread = threading.Thread(target=run_first)
        thread.start()
        self.assertTrue(gate.wait(5))
        results["second"] = second.start()
        thread.join(10)
        self.assertTrue(results["first"]["ok"], results)
        self.assertEqual(results["second"]["code"], "lifecycle_busy")
        self.assertEqual(first.events.count("create_process_suspended"), 1)
        self.assertNotIn("create_process_suspended", second.events)
        self.track_members()
        note(
            "concurrent-start",
            pid=results["first"]["pid"],
            creation=results["first"]["creation"],
            second=results["second"]["code"],
        )

    def test_restart_rechecks_and_warns(self) -> None:
        started = self.supervisor.start()
        self.track_members()
        ready = self.supervisor.mark_ready(lambda: "ready")
        self.assertEqual(ready["state"], "ready", ready)
        seen = {}

        def probe_pending() -> str:
            record = json.loads((Path(self.tmp.name) / "lifecycle.json").read_text(encoding="utf-8"))
            seen["pending"] = record["restart_pending"]
            seen["simulated"] = self.supervisor.create_simulated_job()
            return "busy"

        refused = self.supervisor.restart(probe_pending)
        self.assertEqual(refused["code"], "uncertain")
        self.assertFalse(refused["signaled"])
        self.assertTrue(seen["pending"])
        self.assertEqual(seen["simulated"]["status"], 409)
        self.assertFalse(seen["simulated"]["launch"])
        self.assertNotIn("terminate_job", self.supervisor.events)
        self.assertTrue(life.process_alive(started["pid"]))
        cleared = json.loads((Path(self.tmp.name) / "lifecycle.json").read_text(encoding="utf-8"))
        self.assertFalse(cleared["restart_pending"])
        self.supervisor.mark_ready(lambda: "ready")
        values = iter(["ready", "busy"])
        flipped = self.supervisor.restart(lambda: next(values))
        self.assertEqual(flipped["code"], "uncertain")
        self.assertFalse(flipped["signaled"])
        self.assertTrue(life.process_alive(started["pid"]))
        for uncertain in ("progress_stale", "error", "timeout", "unavailable", "uncertain"):
            self.supervisor.mark_ready(lambda: "ready")
            result = self.supervisor.restart(lambda uncertain=uncertain: uncertain)
            self.assertEqual(result["code"], "uncertain", uncertain)
            self.assertFalse(result["signaled"])
            self.assertTrue(life.process_alive(started["pid"]))
            self.assertNotIn("terminate_job", self.supervisor.events)
        done = self.supervisor.restart(lambda: "ready")
        self.assertEqual(done["code"], life.RACE_CODE)
        self.assertEqual(done["warning"], life.RACE_WARNING)
        self.assertFalse(done["interruption_free"])
        self.assertTrue(done["signaled"])
        self.assertIn("terminate_job", self.supervisor.events)
        self.assertFalse(life.process_alive(started["pid"]))
        note("restart", pid=started["pid"], creation=started["creation"], code=done["code"], alive=False)

    def test_concurrent_restart_terminates_once(self) -> None:
        started = self.supervisor.start()
        self.track_members()
        self.supervisor.mark_ready(lambda: "ready")
        other = self.make()
        gate = threading.Event()
        self.supervisor.on_locked = gate.set
        results: dict[str, dict] = {}

        def run_first() -> None:
            results["first"] = self.supervisor.restart(lambda: "ready")

        thread = threading.Thread(target=run_first)
        thread.start()
        self.assertTrue(gate.wait(5))
        results["second"] = other.restart(lambda: "ready")
        thread.join(10)
        self.assertEqual(results["first"]["code"], life.RACE_CODE, results)
        self.assertEqual(results["second"]["code"], "lifecycle_busy")
        self.assertEqual(self.supervisor.events.count("terminate_job"), 1)
        self.assertNotIn("terminate_job", other.events)
        self.assertFalse(life.process_alive(started["pid"]))
        note("concurrent-restart", pid=started["pid"], creation=started["creation"], second=results["second"]["code"])

    def _tamper(self, **changes) -> None:
        path = Path(self.tmp.name) / "lifecycle.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record.update(changes)
        path.write_text(json.dumps(record), encoding="utf-8")


class BoundaryCase(unittest.TestCase):
    def test_production_bridge_has_no_lifecycle_route_or_csp_exception(self) -> None:
        source = Path(r"C:\Transfert\iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn("connect-src 'self'", source)
        self.assertNotIn("8776", source)
        self.assertNotIn("hq_forge_lifecycle", source)
        self.assertNotIn("/lifecycle/start", source)

    def test_live_hq_has_no_lifecycle_action(self) -> None:
        request = Request(
            "http://127.0.0.1:8765/api/forge/lifecycle/start",
            data=b"{}",
            method="POST",
            headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:8765"},
        )
        try:
            with urlopen(request, timeout=5) as response:
                status = response.status
        except HTTPError as exc:
            status = exc.code
        except OSError as exc:
            self.skipTest(f"production HQ is not reachable: {exc}")
        self.assertEqual(status, 401)
        note("port-8765", status=status)

    def test_fixture_rejects_anonymous_foreign_lan_and_tailscale(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        nonce = uuid.uuid4().hex[:12]
        supervisor = life.Supervisor(
            Path(tmp.name),
            f"Local\\TransfertHQ-M1-{nonce}",
            f"Local\\TransfertHQ-M1-Mutex-{nonce}",
        )
        allowed = "http://127.0.0.1:8765"

        def role(cookie: str) -> str:
            if cookie == "transfert_session=m1-admin":
                return "admin"
            if cookie == "transfert_session=m1-upload":
                return "upload"
            return ""

        fixture = life.ActionFixture(supervisor, allowed, role, lambda: "ready")
        tracked: list[tuple[int, int, str]] = []
        try:
            preflight = self._exchange(fixture.port, "OPTIONS", allowed, preflight=True)
            self.assertEqual(preflight.status, 204)
            self.assertEqual(fixture.calls[-1]["kind"], "preflight")
            self.assertFalse(fixture.calls[-1]["cookie_present"])
            self.assertNotIn("cookie", fixture.calls[-1])
            anonymous = self._exchange(fixture.port, "POST", allowed, b"{}")
            self.assertEqual(anonymous.status, 401)
            foreign = self._exchange(
                fixture.port, "POST", "http://127.0.0.1:8774", b"{}", cookie="transfert_session=m1-admin"
            )
            self.assertEqual(foreign.status, 403)
            lan = self._exchange(
                fixture.port, "POST", "http://192.168.2.22:8765", b"{}", cookie="transfert_session=m1-admin"
            )
            self.assertEqual(lan.status, 403)
            tailscale = self._exchange(
                fixture.port,
                "POST",
                "https://vieuxpeepee.taila4d470.ts.net",
                b"{}",
                cookie="transfert_session=m1-admin",
            )
            self.assertEqual(tailscale.status, 403)
            upload = self._exchange(
                fixture.port, "POST", allowed, b"{}", cookie="transfert_session=m1-upload"
            )
            self.assertEqual(upload.status, 403)
            arbitrary = self._exchange(
                fixture.port,
                "POST",
                allowed,
                b'{"executable":"C:\\\\Windows\\\\System32\\\\cmd.exe","args":"--api"}',
                cookie="transfert_session=m1-admin",
            )
            self.assertEqual(arbitrary.status, 400)
            self.assertNotIn("create_process_suspended", supervisor.events)
            accepted = self._exchange(
                fixture.port, "POST", allowed, b"{}", cookie="transfert_session=m1-admin"
            )
            self.assertEqual(accepted.status, 200, accepted.body)
            body = json.loads(accepted.body)
            self.assertEqual(body["code"], "starting")
            record = json.loads((Path(tmp.name) / "lifecycle.json").read_text(encoding="utf-8"))
            tracked.append((record["pid"], record["creation"], "cmd.exe"))
            self.assertTrue(life.process_alive(record["pid"]))
            self.assertNotIn("m1-admin", json.dumps(fixture.calls), "session leaked")
            refused_socket = socket.socket()
            refused_socket.settimeout(2)
            try:
                refused_socket.connect((self._non_loopback(), fixture.port))
                connected = True
            except OSError:
                connected = False
            finally:
                refused_socket.close()
            self.assertFalse(connected)
            note(
                "browser-fixture",
                listener_port=fixture.port,
                allowed_origin=allowed,
                pid=record["pid"],
                creation=record["creation"],
                anonymous=anonymous.status,
                foreign=foreign.status,
                lan=lan.status,
                tailscale=tailscale.status,
                arbitrary=arbitrary.status,
                non_loopback_connected=connected,
            )
        finally:
            fixture.close()
            supervisor.terminate_if_proven()
            supervisor.close_supervisor_handles()
            for pid, creation, suffix in tracked:
                outcome = life.harness_stop(pid, creation, suffix)
                if outcome not in {"stopped-by-harness", "already-gone"}:
                    ORPHANS.append({"pid": pid, "creation": creation, "outcome": outcome})
            tmp.cleanup()

    def _exchange(self, port: int, method: str, origin: str, body: bytes | None = None, cookie: str = "", preflight: bool = False):
        headers = {"Origin": origin}
        if cookie:
            headers["Cookie"] = cookie
        if preflight:
            headers["Access-Control-Request-Method"] = "POST"
            headers["Access-Control-Request-Headers"] = "Content-Type"
        else:
            headers["Content-Type"] = "application/json"
        request = Request(f"http://127.0.0.1:{port}/lifecycle/start", data=body, method=method, headers=headers)
        try:
            with urlopen(request, timeout=20) as response:
                return _Reply(response.status, response.read())
        except HTTPError as exc:
            return _Reply(exc.code, exc.read())

    def _non_loopback(self) -> str:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("8.8.8.8", 80))
            address = probe.getsockname()[0]
        finally:
            probe.close()
        if address.startswith("127."):
            self.skipTest("no non-loopback address")
        return address


class _Reply:
    def __init__(self, status: int, body: bytes) -> None:
        self.status = status
        self.body = body


def setUpModule() -> None:
    global FORGE_PID_BEFORE
    FORGE_PID_BEFORE = forge_listener_pid()


def tearDownModule() -> None:
    after = forge_listener_pid()
    destination = os.environ.get("HQ_M1_EVIDENCE")
    if destination:
        Path(destination).write_text(json.dumps({
            "forge_listener_pid_before": FORGE_PID_BEFORE,
            "forge_listener_pid_after": after,
            "orphans": ORPHANS,
            "cases": EVIDENCE,
        }, indent=2) + "\n", encoding="utf-8")
    if FORGE_PID_BEFORE != after:
        raise AssertionError(f"Forge listener changed from {FORGE_PID_BEFORE} to {after}")
    if ORPHANS:
        raise AssertionError(f"sleepers left without a proven cleanup: {ORPHANS}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
