"""M2a admission lock, HQ sessions, and fixture-port authorization.

These tests do not bind 127.0.0.1:8765, do not enable the production listener,
and do not launch Forge. A page and listener on any other port pair is not
evidence of the production 8765 to 8776 browser integration.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import threading
import unittest
import uuid
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_jobs as jobs  # noqa: E402
import hq_forge_lifecycle as life  # noqa: E402

EVIDENCE: list[dict] = []
ORPHANS: list[dict] = []
FORGE_BEFORE: int | None = None
PAGE_ORIGIN = "http://127.0.0.1:8765"
LISTENER_ORIGIN = "http://127.0.0.1:8776"


def forge_listener_pid() -> int | None:
    output = subprocess.check_output(["netstat", "-ano", "-p", "tcp"], text=True, encoding="utf-8", errors="replace")
    for line in output.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[1].startswith("127.0.0.1:7860") and parts[3] == "LISTENING":
            return int(parts[4])
    return None


def note(test: str, **facts) -> None:
    EVIDENCE.append({"test": test, **facts})


def setUpModule() -> None:
    global FORGE_BEFORE
    FORGE_BEFORE = forge_listener_pid()


def tearDownModule() -> None:
    after = forge_listener_pid()
    if after != FORGE_BEFORE:
        raise AssertionError(f"forge listener changed {FORGE_BEFORE} -> {after}")
    if ORPHANS:
        raise AssertionError(ORPHANS)
    path = Path(os_environ_evidence())
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"forge_before": FORGE_BEFORE, "forge_after": after, "cases": EVIDENCE}, indent=2) + "\n", encoding="utf-8")


def os_environ_evidence() -> str:
    import os
    return os.environ.get("HQ_M2A_EVIDENCE", r"C:\Transfert-reviews\forge-lifecycle-m2a\evidence.json")


class Transport:
    def __call__(self, method, url, timeout, body=None):
        if not str(url).startswith("http://127.0.0.1:"):
            raise AssertionError(url)
        path = str(url).split("://", 1)[1]
        path = path[path.find("/"):].split("?", 1)[0]
        if "interrupt" in path:
            raise AssertionError(path)
        if method == "POST":
            return 200, b'{"images":[],"parameters":{},"info":"{}"}'
        table = {
            "/sdapi/v1/sd-models": [{"title": "example.safetensors [abcd]", "model_name": "example", "hash": "abcd", "sha256": None}],
            "/sdapi/v1/samplers": [{"name": "Euler"}],
            "/sdapi/v1/schedulers": [{"name": "automatic", "label": "Automatic"}],
            "/sdapi/v1/upscalers": [{"name": "R-ESRGAN 4x+"}, {"name": "None"}],
            "/sdapi/v1/options": {"sd_model_checkpoint": "example.safetensors"},
            "/internal/pending-tasks": {"size": 0, "tasks": []},
            "/sdapi/v1/progress": {"progress": 0, "state": {"job": "", "job_count": 0, "sampling_step": 0, "sampling_steps": 1}},
        }
        if path not in table:
            raise AssertionError(path)
        return 200, json.dumps(table[path]).encode("utf-8")


def body() -> dict:
    return {
        "prompt": "a red circle",
        "negative_prompt": "blur",
        "checkpoint": "example.safetensors [abcd]",
        "sampler_name": "Euler",
        "scheduler": "automatic",
        "width": 512,
        "height": 512,
        "steps": 8,
        "cfg_scale": 6,
        "seed": -1,
        "n_iter": 1,
        "batch_size": 1,
    }


class Admission(unittest.TestCase):
    def setUp(self) -> None:
        jobs.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        jobs.set_poll_interval_for_tests(0.05)
        self.transport = Transport()

    def tearDown(self) -> None:
        import time
        jobs.set_admission_hook_for_tests(None)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                _code, payload = jobs.list_jobs(self.root)
            except OSError:
                break
            if all(job.get("state") in jobs.TERMINAL for job in payload.get("jobs") or []):
                break
            time.sleep(0.05)
        time.sleep(0.3)
        jobs.reset_for_tests()
        self.tmp.cleanup()

    def admit(self, key: str = "idem-m2a-01") -> tuple[int, dict]:
        return jobs.create_job(self.root, body(), key, transport=self.transport)

    def test_pending_refuses_new_job_and_replays_existing(self) -> None:
        code, payload = self.admit()
        self.assertEqual(code, 202, payload)
        self.assertTrue(jobs.claim_restart(self.root)[0] is False)
        self._wait(payload["job"]["job_id"])
        claimed, _reason, token = jobs.claim_restart(self.root)
        self.assertTrue(claimed)
        replay, replayed = self.admit()
        self.assertEqual(replay, 200, replayed)
        blocked, refused = jobs.create_job(self.root, body(), "idem-m2a-02", transport=self.transport)
        self.assertEqual(blocked, 409)
        self.assertEqual(refused["code"], "lifecycle_busy")
        self.assertFalse(jobs.abort_unsignaled_restart(self.root, "stale-token"))
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertTrue(jobs.abort_unsignaled_restart(self.root, token))
        opened, _again = jobs.create_job(self.root, body(), "idem-m2a-03", transport=self.transport)
        self.assertEqual(opened, 202)
        note("pending-blocks-admission", replay=replay, blocked=refused["code"])

    def test_active_job_blocks_restart_claim(self) -> None:
        code, payload = self.admit("idem-m2a-active")
        self.assertEqual(code, 202, payload)
        claimed, reason, _token = jobs.claim_restart(self.root)
        self.assertFalse(claimed)
        self.assertEqual(reason, "active")
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        note("active-blocks-restart", reason=reason)

    def test_admit_holds_lock_before_restart_claim(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        trying = threading.Event()

        def hook(point: str) -> None:
            if point == "before_admit":
                entered.set()
                self.assertTrue(release.wait(5))

        jobs.set_admission_hook_for_tests(hook)
        outcome: dict = {}

        def run_admit() -> None:
            outcome["admit"] = self.admit("idem-m2a-race-a")

        def run_claim() -> None:
            self.assertTrue(entered.wait(5))
            trying.set()
            outcome["claim"] = jobs.claim_restart(self.root)

        first = threading.Thread(target=run_admit)
        second = threading.Thread(target=run_claim)
        first.start()
        second.start()
        self.assertTrue(trying.wait(5))
        release.set()
        first.join(5)
        second.join(5)
        self.assertEqual(outcome["admit"][0], 202)
        self.assertFalse(outcome["claim"][0])
        self.assertEqual(outcome["claim"][1], "active")
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        note("admit-before-claim", claim=outcome["claim"][1])

    def test_claim_holds_lock_before_admit(self) -> None:
        entered = threading.Event()
        release = threading.Event()
        trying = threading.Event()

        def hook(point: str) -> None:
            if point == "claim_held":
                entered.set()
                self.assertTrue(release.wait(5))

        jobs.set_admission_hook_for_tests(hook)
        outcome: dict = {}

        def run_claim() -> None:
            outcome["claim"] = jobs.claim_restart(self.root)

        def run_admit() -> None:
            self.assertTrue(entered.wait(5))
            trying.set()
            outcome["admit"] = self.admit("idem-m2a-race-b")

        first = threading.Thread(target=run_claim)
        second = threading.Thread(target=run_admit)
        first.start()
        second.start()
        self.assertTrue(trying.wait(5))
        release.set()
        first.join(5)
        second.join(5)
        self.assertEqual(outcome["claim"][:2], (True, "ok"))
        self.assertEqual(outcome["admit"][0], 409)
        self.assertEqual(outcome["admit"][1]["code"], "lifecycle_busy")
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertFalse(jobs.restart_gate(self.root)["signaled"])
        note("claim-before-admit", admit=outcome["admit"][1]["code"])

    def test_interrupted_claim_stays_closed_until_abort(self) -> None:
        claimed, _reason, token = jobs.claim_restart(self.root)
        self.assertTrue(claimed)
        blocked, refused = self.admit("idem-m2a-interrupt")
        self.assertEqual((blocked, refused["code"]), (409, "lifecycle_busy"))
        self.assertFalse(jobs.abort_unsignaled_restart(self.root, "other-preparation"))
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertTrue(jobs.abort_unsignaled_restart(self.root, token))
        opened, opened_body = self.admit("idem-m2a-interrupt")
        self.assertEqual(opened, 202)
        self._wait(opened_body["job"]["job_id"])
        claimed, _reason, token = jobs.claim_restart(self.root)
        self.assertTrue(claimed)
        self.assertTrue(jobs.seal_restart(self.root, token))
        self.assertFalse(jobs.abort_unsignaled_restart(self.root, token))
        self.assertFalse(jobs.abort_unsignaled_restart(self.root, "other-preparation"))
        sealed, sealed_body = jobs.create_job(self.root, body(), "idem-m2a-sealed", transport=self.transport)
        self.assertEqual((sealed, sealed_body["code"]), (409, "lifecycle_busy"))
        self.assertTrue(jobs.restart_gate(self.root)["sealed"])
        note("interrupted-fail-closed", abort_after_seal=False)

    def test_unreadable_gate_fails_closed(self) -> None:
        path = self.root / ".hq-forge"
        path.mkdir(parents=True)
        (path / "restart-gate.json").write_text("{", encoding="utf-8")
        blocked, refused = self.admit("idem-m2a-garbled")
        self.assertEqual((blocked, refused["code"]), (409, "lifecycle_busy"))
        note("garbled-gate", code=refused["code"])

    def test_gate_record_table(self) -> None:
        token = "ab" * 16
        valid_pending = {
            "version": 1, "pending": True, "signaled": False, "sealed": False,
            "token": token, "epoch": 1,
        }

        def without(field: str) -> dict:
            record = dict(valid_pending)
            record.pop(field)
            return record

        invalid = {
            "missing-version": without("version"),
            "missing-pending": without("pending"),
            "missing-signaled": without("signaled"),
            "missing-sealed": without("sealed"),
            "missing-token": without("token"),
            "missing-epoch": without("epoch"),
            "pending-string-false": {**valid_pending, "pending": "false"},
            "pending-string-true": {**valid_pending, "pending": "true"},
            "pending-null": {**valid_pending, "pending": None},
            "pending-zero": {**valid_pending, "pending": 0},
            "pending-one": {**valid_pending, "pending": 1},
            "signaled-string": {**valid_pending, "signaled": "false"},
            "signaled-null": {**valid_pending, "signaled": None},
            "sealed-string": {**valid_pending, "sealed": "true"},
            "sealed-null": {**valid_pending, "sealed": None},
            "sealed-one": {**valid_pending, "sealed": 1},
            "token-null": {**valid_pending, "token": None},
            "token-int": {**valid_pending, "token": 1},
            "token-empty": {**valid_pending, "token": ""},
            "token-short": {**valid_pending, "token": "abcd"},
            "token-upper": {**valid_pending, "token": "AB" * 16},
            "epoch-string": {**valid_pending, "epoch": "1"},
            "epoch-null": {**valid_pending, "epoch": None},
            "epoch-bool": {**valid_pending, "epoch": True},
            "epoch-negative": {**valid_pending, "epoch": -1},
            "epoch-float": {**valid_pending, "epoch": 1.0},
            "epoch-zero-while-pending": {**valid_pending, "epoch": 0},
            "version-string": {**valid_pending, "version": "1"},
            "version-two": {**valid_pending, "version": 2},
            "version-bool": {**valid_pending, "version": True},
            "sealed-while-open": {**valid_pending, "pending": False, "sealed": True, "signaled": False},
            "signaled-while-open": {**valid_pending, "pending": False, "signaled": True, "sealed": True},
            "signaled-without-sealed": {**valid_pending, "signaled": True, "sealed": False},
            "open-with-token": {
                "version": 1, "pending": False, "signaled": False, "sealed": False,
                "token": token, "epoch": 1,
            },
        }
        raw = {
            "truncated": b"{",
            "array": b"[]",
            "text": b"\"pending\"",
        }
        folder = self.root / ".hq-forge"
        folder.mkdir(parents=True)
        path = folder / "restart-gate.json"
        index = 0
        for name, record in {**invalid, **{key: None for key in raw}}.items():
            with self.subTest(name=name):
                if name in raw:
                    payload = raw[name]
                else:
                    payload = json.dumps(record).encode("utf-8")
                path.write_bytes(payload)
                index += 1
                blocked, refused = jobs.create_job(
                    self.root, body(), f"idem-gate-{index:02d}", transport=self.transport,
                )
                self.assertEqual(blocked, 409)
                self.assertEqual(refused["code"], "lifecycle_busy")
                claimed, reason, _owner = jobs.claim_restart(self.root)
                self.assertFalse(claimed)
                self.assertEqual(reason, "restart_pending")
                self.assertEqual(path.read_bytes(), payload)
        path.write_bytes(json.dumps({
            "version": 1, "pending": False, "signaled": False, "sealed": False, "token": "", "epoch": 4,
        }).encode("utf-8"))
        opened, opened_body = self.admit("idem-gate-open")
        self.assertEqual(opened, 202, opened_body)
        self._wait(opened_body["job"]["job_id"])
        for name, record in {
            "pending": valid_pending,
            "signaled": {**valid_pending, "signaled": True, "sealed": True, "epoch": 2},
            "sealed": {**valid_pending, "sealed": True, "epoch": 3},
        }.items():
            with self.subTest(valid=name):
                payload = json.dumps(record).encode("utf-8")
                path.write_bytes(payload)
                index += 1
                blocked, refused = jobs.create_job(
                    self.root, body(), f"idem-gate-v-{index:02d}", transport=self.transport,
                )
                self.assertEqual((blocked, refused["code"]), (409, "lifecycle_busy"))
                claimed, reason, _owner = jobs.claim_restart(self.root)
                self.assertFalse(claimed)
                self.assertEqual(reason, "restart_pending")
                self.assertEqual(path.read_bytes(), payload)
        note("gate-record-table", invalid=len(invalid) + len(raw), valid_closed=3)

    def _wait(self, job_id: str) -> None:
        import time
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            _code, payload = jobs.get_job(self.root, job_id)
            if payload["job"]["state"] in jobs.TERMINAL:
                return
            time.sleep(0.05)
        self.fail(payload)


class SleeperSync(unittest.TestCase):
    def setUp(self) -> None:
        jobs.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.nonce = uuid.uuid4().hex[:12]
        self.tracked: list[tuple[int, int, str]] = []
        self.supervisor = life.Supervisor(
            self.root / "life",
            f"Local\\TransfertHQ-M1-{self.nonce}",
            f"Local\\TransfertHQ-M1-Mutex-{self.nonce}",
            jobs_root=self.root,
        )

    def tearDown(self) -> None:
        self.track()
        for pid, creation, suffix in self.tracked:
            if life.process_alive(pid):
                result = life.harness_stop(pid, creation, suffix)
                if life.process_alive(pid):
                    ORPHANS.append({"pid": pid, "creation": creation, "result": result})
        jobs.reset_for_tests()
        self.tmp.cleanup()

    def track(self) -> None:
        path = self.root / "life" / "lifecycle.json"
        if not path.is_file():
            return
        record = json.loads(path.read_text(encoding="utf-8"))
        items = list(record.get("members") or [])
        if "pid" in record and "creation" in record:
            items.append({"pid": record["pid"], "creation": record["creation"], "image": record.get("image") or "cmd.exe"})
        for item in items:
            image = str(item.get("image") or "")
            suffix = "cmd.exe" if image.lower().endswith("cmd.exe") else Path(image).name
            row = (int(item["pid"]), int(item["creation"]), suffix or "cmd.exe")
            if row not in self.tracked:
                self.tracked.append(row)

    def test_uncertain_probe_clears_admission(self) -> None:
        started = self.supervisor.start()
        self.track()
        self.assertTrue(self.supervisor.mark_ready(lambda: "ready")["ok"])
        refused = self.supervisor.restart(lambda: "busy")
        self.assertEqual(refused["code"], "uncertain")
        self.assertFalse(refused["signaled"])
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        self.assertTrue(life.process_alive(started["pid"]))
        self.assertNotIn("terminate_job", self.supervisor.events)
        note("uncertain-clears", pid=started["pid"], alive=True)

    def test_successful_restart_reports_race_and_clears_gate(self) -> None:
        started = self.supervisor.start()
        self.track()
        self.supervisor.mark_ready(lambda: "ready")
        done = self.supervisor.restart(lambda: "ready")
        self.assertEqual(done["code"], life.RACE_CODE)
        self.assertEqual(done["warning"], life.RACE_WARNING)
        self.assertFalse(done["interruption_free"])
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        self.assertFalse(life.process_alive(started["pid"]))
        note("race-warning", pid=started["pid"], code=done["code"])

    def test_stale_creation_does_not_signal(self) -> None:
        started = self.supervisor.start()
        self.track()
        path = self.root / "life" / "lifecycle.json"
        record = json.loads(path.read_text(encoding="utf-8"))
        record["creation"] = int(record["creation"]) + 1
        path.write_text(json.dumps(record), encoding="utf-8")
        refused = self.supervisor.terminate_if_proven()
        self.assertFalse(refused["signaled"])
        self.assertEqual(refused["code"], "unmanaged")
        self.assertTrue(life.process_alive(started["pid"]))
        self.assertEqual(life.process_creation(started["pid"]), started["creation"])
        note("stale-creation", pid=started["pid"], alive=True, signaled=False)

    def test_active_hq_job_blocks_supervisor_restart(self) -> None:
        started = self.supervisor.start()
        self.track()
        self.supervisor.mark_ready(lambda: "ready")
        folder = self.root / ".hq-forge"
        folder.mkdir(parents=True)
        (folder / "jobs.json").write_text(json.dumps({
            "jobs": [{"id": "job-" + "ab" * 12, "state": "generating", "progress_stale": False}],
            "idempotency": {},
        }), encoding="utf-8")
        refused = self.supervisor.restart(lambda: "ready")
        self.assertEqual(refused["code"], "active")
        self.assertFalse(refused["signaled"])
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        self.assertTrue(life.process_alive(started["pid"]))
        self.assertNotIn("terminate_job", self.supervisor.events)
        note("active-job-blocks-signal", pid=started["pid"], alive=True)


class Sessions(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        config_path = SOURCE / "bridge_config.json"
        cls.config_existed = config_path.is_file()
        import iphone_bridge as bridge
        cls.bridge = bridge
        cls.config_path = bridge.CONFIG_PATH
        cls.saved_sessions = bridge.SESSIONS_PATH
        cls.saved_pin = bridge.CONFIG.get("pin")
        cls.saved_users = json.loads(json.dumps(bridge.CONFIG.get("users") or []))
        cls.tmp = tempfile.TemporaryDirectory()
        bridge.SESSIONS_PATH = Path(cls.tmp.name) / "bridge_sessions.json"
        bridge._SESSIONS.clear()
        bridge.CONFIG["pin"] = "m2a-disposable-pin"
        bridge.CONFIG["users"] = [{"name": "upload-test", "pin": "m2a-upload-pin", "role": "upload"}]

    @classmethod
    def tearDownClass(cls) -> None:
        bridge = cls.bridge
        bridge.SESSIONS_PATH = cls.saved_sessions
        bridge._SESSIONS.clear()
        bridge.CONFIG["pin"] = cls.saved_pin
        bridge.CONFIG["users"] = cls.saved_users
        cls.tmp.cleanup()
        if not cls.config_existed and cls.config_path.is_file() and cls.config_path.parent == SOURCE:
            cls.config_path.unlink()

    def setUp(self) -> None:
        self.bridge._SESSIONS.clear()
        path = self.bridge.SESSIONS_PATH
        if path.is_file():
            path.unlink()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.nonce = uuid.uuid4().hex[:12]
        self.tracked: list[tuple[int, int, str]] = []
        self.supervisor = life.Supervisor(
            self.root,
            f"Local\\TransfertHQ-M1-{self.nonce}",
            f"Local\\TransfertHQ-M1-Mutex-{self.nonce}",
        )
        self.fixture = None

    def tearDown(self) -> None:
        if self.fixture is not None:
            self.fixture.close()
        path = self.root / "lifecycle.json"
        if path.is_file():
            record = json.loads(path.read_text(encoding="utf-8"))
            items = list(record.get("members") or [])
            if "pid" in record:
                items.append(record)
            for item in items:
                if "pid" not in item or "creation" not in item:
                    continue
                image = str(item.get("image") or "cmd.exe")
                suffix = "cmd.exe" if image.lower().endswith("cmd.exe") else Path(image).name
                pid = int(item["pid"])
                if life.process_alive(pid):
                    result = life.harness_stop(pid, int(item["creation"]), suffix or "cmd.exe")
                    if life.process_alive(pid):
                        ORPHANS.append({"pid": pid, "result": result})
        self.tmp.cleanup()

    def listener(self, origin: str):
        self.fixture = life.ActionFixture(self.supervisor, origin, None, lambda: "ready", use_hq_session=True)
        return self.fixture

    def post(self, origin: str, cookie: str | None, payload: dict | None = None, method: str = "POST") -> tuple[int, bytes]:
        port = self.fixture.port
        data = b"{}" if payload is None else json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json", "Content-Length": str(len(data))}
        if origin:
            headers["Origin"] = origin
        if cookie:
            headers["Cookie"] = cookie
        request = Request(f"http://127.0.0.1:{port}/lifecycle/start", data=data, headers=headers, method=method)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, response.read()
        except HTTPError as exc:
            return exc.code, exc.read()

    def test_admin_session_revocation_and_roles(self) -> None:
        admin = self.bridge.issue_session("admin", "admin")
        upload = self.bridge.issue_session("upload-test", "upload")
        self.listener(PAGE_ORIGIN)
        status, _body = self.post(PAGE_ORIGIN, None)
        self.assertEqual(status, 401)
        status, _body = self.post(PAGE_ORIGIN, f"transfert_session={upload}")
        self.assertEqual(status, 403)
        status, body = self.post(PAGE_ORIGIN, f"transfert_session={admin}")
        self.assertEqual(status, 200, body)
        self.assertIn(b"starting", body)
        self.bridge.revoke_session(admin)
        status, _body = self.post(PAGE_ORIGIN, f"transfert_session={admin}")
        self.assertEqual(status, 401)
        dumped = json.dumps(self.fixture.calls)
        self.assertNotIn(admin, dumped, "session leaked")
        self.assertNotIn(upload, dumped, "session leaked")
        self.assertNotIn("transfert_session=", dumped)
        note(
            "hq-session",
            listener_port=self.fixture.port,
            page_origin_header=PAGE_ORIGIN,
            production_pair_exercised=False,
            document_served_from_8765=False,
        )

    def test_origin_and_body_rejection(self) -> None:
        admin = self.bridge.issue_session("admin", "admin")
        cookie = f"transfert_session={admin}"
        self.listener(PAGE_ORIGIN)
        for origin in ("", "http://127.0.0.1:8774", "http://192.168.2.22:8765", "https://vieuxpeepee.taila4d470.ts.net"):
            status, _body = self.post(origin, cookie)
            self.assertEqual(status, 403, origin or "missing")
        status, _body = self.post(PAGE_ORIGIN, cookie, {"executable": "C:\\Windows\\System32\\cmd.exe"})
        self.assertEqual(status, 400)
        self.assertNotIn("create_process_suspended", self.supervisor.events)
        note("origin-rejection", events=list(self.supervisor.events), production_pair_exercised=False)

    def test_preflight_exact_origin(self) -> None:
        self.listener(PAGE_ORIGIN)
        port = self.fixture.port

        def options(origin: str, method: str, headers: str, private: str = "") -> int:
            extra = {
                "Origin": origin,
                "Access-Control-Request-Method": method,
                "Access-Control-Request-Headers": headers,
            }
            if private:
                extra["Access-Control-Request-Private-Network"] = private
            request = Request(f"http://127.0.0.1:{port}/lifecycle/start", method="OPTIONS", headers=extra)
            try:
                with urlopen(request, timeout=5) as response:
                    return response.status
            except HTTPError as exc:
                return exc.code

        self.assertEqual(options(PAGE_ORIGIN, "POST", "content-type"), 204)
        self.assertEqual(options("http://192.168.2.22:8765", "POST", "content-type"), 403)
        self.assertEqual(options(PAGE_ORIGIN, "PUT", "content-type"), 403)
        self.assertEqual(options(PAGE_ORIGIN, "POST", "content-type,x-pin"), 403)
        self.assertEqual(options(PAGE_ORIGIN, "POST", "content-type", "true"), 403)
        note("preflight", production_pair_exercised=False)

    def test_diagnostics_redact_cookie_pin_and_session(self) -> None:
        admin = self.bridge.issue_session("admin", "admin")
        pin = "m2a-disposable-pin"
        raw = f"Cookie: transfert_session={admin}; pin={pin}; authorization={admin}"
        cleaned = life.redact_diagnostics(raw)
        self.assertNotIn(admin, cleaned, "session leaked")
        self.assertNotIn(pin, cleaned, "pin leaked")
        self.assertIn("<redacted>", cleaned)
        note("redaction", leaked=False)

    def test_hq_routes_and_csp_unchanged(self) -> None:
        source = (SOURCE / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn("connect-src 'self'", source)
        self.assertNotIn("8776", source)
        self.assertNotIn("hq_forge_lifecycle", source)
        self.assertNotIn("/lifecycle/start", source)
        self.assertFalse(life.PRODUCT_LISTENER_ENABLED)
        self.assertFalse(life.FORGE_LAUNCH_ENABLED)
        self.assertEqual(life.LISTENER_PROCESS, "separate")
        self.assertNotEqual(jobs.admission_mutex_name(self.root), jobs.PRODUCT_ADMISSION_MUTEX)
        self.assertTrue(jobs.admission_mutex_name(self.root).startswith("Local\\TransfertHQ-M1-Admission-"))
        page_open = life.loopback_open(8765)
        listener_open = life.loopback_open(8776)
        forge_open = life.loopback_open(7860)
        note(
            "ports",
            page_8765_accepting=page_open,
            listener_8776_accepting=listener_open,
            forge_7860_accepting=forge_open,
            production_page_served_by_this_test=False,
            production_listener_enabled=False,
            reserved_ports_bound_by_this_test=False,
            alternate_pair_is_not_production_proof=True,
        )
        self.assertTrue(page_open)
        self.assertFalse(listener_open)
        self.assertTrue(forge_open)

    def test_non_loopback_does_not_complete(self) -> None:
        self.listener(PAGE_ORIGIN)
        sock_error = None
        import socket
        probe = socket.socket()
        probe.settimeout(0.4)
        try:
            probe.connect(("192.168.2.22", self.fixture.port))
            sock_error = "connected"
        except OSError as exc:
            sock_error = type(exc).__name__
        finally:
            probe.close()
        self.assertNotEqual(sock_error, "connected")
        note("non-loopback", error=sock_error, port=self.fixture.port)

    def test_other_process_reloads_revocation(self) -> None:
        admin = self.bridge.issue_session("admin", "admin")
        cookie = self.root / "cookie.txt"
        cookie.write_text(admin, encoding="utf-8")
        first = self.root / "role-before.json"
        second = self.root / "role-after.json"
        code = _worker([
            "--root", str(self.root), "--mode", "session",
            "--sessions", str(self.bridge.SESSIONS_PATH),
            "--cookie-file", str(cookie), "--result", str(first),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(first.read_text(encoding="utf-8"))["role"], "admin")
        self.bridge.revoke_session(admin)
        code = _worker([
            "--root", str(self.root), "--mode", "session",
            "--sessions", str(self.bridge.SESSIONS_PATH),
            "--cookie-file", str(cookie), "--result", str(second),
        ])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(second.read_text(encoding="utf-8"))["role"], "")
        self.assertNotIn(admin, first.read_text(encoding="utf-8"), "session leaked")
        note("cross-process-session", revoked=True, production_pair_exercised=False)


def _worker(args: list[str], timeout: float = 20) -> int:
    completed = subprocess.run(
        [sys.executable, str(SOURCE / "tests" / "m2a_gate_worker.py"), *args],
        cwd=str(SOURCE),
        timeout=timeout,
        capture_output=True,
        text=True,
    )
    if completed.returncode not in (0, 91, 92):
        detail = (completed.stderr or completed.stdout or "")[-800:].replace("m2a-disposable-pin", "<redacted>")
        raise AssertionError(f"{completed.returncode} {detail}")
    return completed.returncode


def _spawn(args: list[str]) -> subprocess.Popen:
    return subprocess.Popen(
        [sys.executable, str(SOURCE / "tests" / "m2a_gate_worker.py"), *args],
        cwd=str(SOURCE),
    )


def _wait_file(path: Path, proc: subprocess.Popen, seconds: float = 10) -> None:
    import time
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if path.is_file() and path.stat().st_size > 0:
            return
        if proc.poll() is not None and not path.is_file():
            break
        time.sleep(0.02)
    raise AssertionError("child did not reach the gate hook")


class CrossProcess(unittest.TestCase):
    def setUp(self) -> None:
        jobs.reset_for_tests()
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        jobs.set_poll_interval_for_tests(0.05)
        self.procs: list[subprocess.Popen] = []

    def tearDown(self) -> None:
        for proc in self.procs:
            if proc.poll() is None:
                proc.kill()
                proc.wait(5)
        jobs.reset_for_tests()
        self.tmp.cleanup()

    def test_second_process_blocks_while_mutex_is_held(self) -> None:
        marker = self.root / "held"
        release = self.root / "release"
        token_file = self.root / "owner-token"
        held_result = self.root / "held.json"
        blocked_result = self.root / "blocked.json"
        holder = _spawn([
            "--root", str(self.root), "--mode", "hold",
            "--marker", str(marker), "--token-file", str(token_file),
            "--release", str(release), "--result", str(held_result),
        ])
        self.procs.append(holder)
        _wait_file(marker, holder)
        blocked = _worker([
            "--root", str(self.root), "--mode", "claim",
            "--timeout-ms", "1500", "--result", str(blocked_result),
        ], timeout=10)
        self.assertEqual(blocked, 0)
        observed = json.loads(blocked_result.read_text(encoding="utf-8"))
        self.assertFalse(observed["ok"])
        self.assertEqual(observed["reason"], "lifecycle_busy")
        release.write_text("go", encoding="utf-8")
        self.assertEqual(holder.wait(10), 0)
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertFalse(jobs.release_restart(self.root, "stale-token"))
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        owner = token_file.read_text(encoding="utf-8")
        self.assertTrue(jobs.release_restart(self.root, owner))
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        note("two-process-mutex", blocked=observed["reason"])

    def test_interruption_before_gate_write(self) -> None:
        marker = self.root / "before"
        token_file = self.root / "intended"
        child = _spawn([
            "--root", str(self.root), "--mode", "before-write",
            "--marker", str(marker), "--token-file", str(token_file),
        ])
        self.procs.append(child)
        _wait_file(marker, child)
        self.assertEqual(child.wait(5), 91)
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        claimed, reason, owner = jobs.claim_restart(self.root)
        self.assertEqual((claimed, reason), (True, "ok"))
        stale = token_file.read_text(encoding="utf-8")
        self.assertFalse(jobs.release_restart(self.root, stale))
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertTrue(jobs.release_restart(self.root, owner))
        note("interrupt-before-write", stale_cleared=False)

    def test_interruption_after_gate_write(self) -> None:
        marker = self.root / "after"
        token_file = self.root / "written"
        admit_result = self.root / "admit.json"
        child = _spawn([
            "--root", str(self.root), "--mode", "after-write",
            "--marker", str(marker), "--token-file", str(token_file),
        ])
        self.procs.append(child)
        _wait_file(marker, child)
        self.assertEqual(child.wait(5), 92)
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertFalse(jobs.restart_gate(self.root)["signaled"])
        self.assertEqual(_worker([
            "--root", str(self.root), "--mode", "admit", "--result", str(admit_result),
        ]), 0)
        admitted = json.loads(admit_result.read_text(encoding="utf-8"))
        self.assertEqual(admitted["status"], 409)
        self.assertEqual(admitted["code"], "lifecycle_busy")
        wrong = self.root / "wrong.json"
        (self.root / "bogus").write_text("not-the-owner", encoding="utf-8")
        self.assertEqual(_worker([
            "--root", str(self.root), "--mode", "release",
            "--token-file", str(self.root / "bogus"), "--result", str(wrong),
        ]), 0)
        self.assertFalse(json.loads(wrong.read_text(encoding="utf-8"))["cleared"])
        self.assertTrue(jobs.restart_gate(self.root)["pending"])
        self.assertTrue(jobs.release_restart(self.root, token_file.read_text(encoding="utf-8")))
        self.assertFalse(jobs.restart_gate(self.root)["pending"])
        note("interrupt-after-write", admitted=409)

    def test_malformed_and_sealed_gates_fail_closed(self) -> None:
        folder = self.root / ".hq-forge"
        folder.mkdir()
        gate = folder / "restart-gate.json"
        gate.write_text("{", encoding="utf-8")
        result = self.root / "malformed.json"
        self.assertEqual(_worker([
            "--root", str(self.root), "--mode", "admit", "--result", str(result),
        ]), 0)
        body = json.loads(result.read_text(encoding="utf-8"))
        self.assertEqual((body["status"], body["code"]), (409, "lifecycle_busy"))
        self.assertEqual(gate.read_text(encoding="utf-8"), "{")
        gate.unlink()
        claimed, _reason, token = jobs.claim_restart(self.root)
        self.assertTrue(claimed)
        self.assertTrue(jobs.seal_restart(self.root, token))
        released = self.root / "sealed-release.json"
        (self.root / "bogus").write_text("not-the-owner", encoding="utf-8")
        self.assertEqual(_worker([
            "--root", str(self.root), "--mode", "release",
            "--token-file", str(self.root / "bogus"), "--result", str(released),
        ]), 0)
        self.assertFalse(json.loads(released.read_text(encoding="utf-8"))["cleared"])
        self.assertTrue(jobs.restart_gate(self.root)["sealed"])
        self.assertFalse(jobs.abort_unsignaled_restart(self.root, token))
        uncertain = self.root / "uncertain.json"
        self.assertEqual(_worker([
            "--root", str(self.root), "--mode", "admit", "--result", str(uncertain),
        ]), 0)
        self.assertEqual(json.loads(uncertain.read_text(encoding="utf-8"))["code"], "lifecycle_busy")
        note("malformed-sealed-uncertain", fail_closed=True)


if __name__ == "__main__":
    unittest.main()
