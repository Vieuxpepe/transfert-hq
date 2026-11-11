"""Side-by-side release layout. Disposable directories and non-production ports only."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
BRIDGE = SOURCE / "iphone_bridge.py"
PORT = "18765"
PLANNER = 18766


def _run_import(env: dict, timeout: int = 30) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(BRIDGE)],
        cwd=str(SOURCE),
        env=env,
        capture_output=True,
        text=True,
        timeout=timeout,
    )


class ReleaseLayoutTests:
    def __init__(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-release-layout-"))
        self.state = self.tmp / "state"
        self.state.mkdir()
        self.code_sessions_existed = (SOURCE / "bridge_sessions.json").exists()

    def env(self, **extra: str) -> dict:
        base = os.environ.copy()
        base["HQ_STATE_ROOT"] = str(self.state)
        base["HQ_PORT"] = PORT
        base.update(extra)
        return base

    def write_config(self) -> None:
        (self.state / "bridge_config.json").write_text(json.dumps({
            "pin": "424242",
            "users": [{"name": "admin", "pin": "424242", "role": "admin"}],
            "bind_host": "127.0.0.1",
            "planner_port": PLANNER,
            "backup_auto_paused": True,
            "automation_enabled": False,
            "schedules_enabled": False,
            "push_enabled": False,
            "disk_probe_enabled": False,
            "screenshot_ingest_enabled": False,
            "folders": ["Inbox", "Uni", "Print"],
            "default_folder": "Inbox",
        }), encoding="utf-8")

    def close(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)


def test_missing_state_is_not_created() -> None:
    parent = Path(tempfile.mkdtemp(prefix="hq-release-parent-"))
    missing = parent / "missing-state"
    env = os.environ.copy()
    env["HQ_STATE_ROOT"] = str(missing)
    env["HQ_PORT"] = PORT
    try:
        completed = _run_import(env)
        text = completed.stderr + completed.stdout
        if completed.returncode == 0 or missing.exists() or "will not be created" not in text:
            raise SystemExit(text or f"rc={completed.returncode}")
    finally:
        shutil.rmtree(parent, ignore_errors=True)


def test_config_is_not_created() -> None:
    harness = ReleaseLayoutTests()
    try:
        completed = _run_import(harness.env())
        text = completed.stderr + completed.stdout
        if completed.returncode == 0 or "refusing to create one" not in text:
            raise SystemExit(text or f"rc={completed.returncode}")
        if (harness.state / "bridge_config.json").exists():
            raise SystemExit("config was created")
    finally:
        harness.close()


def test_live_split() -> None:
    harness = ReleaseLayoutTests()
    proc = None
    try:
        harness.write_config()
        decoy_dir = harness.state / "assets"
        decoy_dir.mkdir()
        (decoy_dir / "hq-household-budget.js").write_text("DECOY-STATE-ASSET", encoding="utf-8")
        proc = subprocess.Popen(
            [sys.executable, str(BRIDGE)],
            cwd=str(SOURCE),
            env=harness.env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        deadline = time.time() + 45
        asset = b""
        while time.time() < deadline:
            if proc.poll() is not None:
                output = proc.stdout.read() if proc.stdout else ""
                raise SystemExit(output or "bridge exited")
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/assets/hq-household-budget.js", timeout=2) as response:
                    asset = response.read()
                break
            except OSError:
                time.sleep(0.3)
        else:
            raise SystemExit("bridge did not answer on the disposable port")
        if b"DECOY-STATE-ASSET" in asset or b"HqHouseholdBudget" not in asset:
            raise SystemExit("asset did not come from the release directory")
        with urllib.request.urlopen(f"http://127.0.0.1:{PORT}/assets/hq-companion.js", timeout=5) as companion:
            if b"function" not in companion.read():
                raise SystemExit("companion asset missing from the release")
        status = _json("GET", f"http://127.0.0.1:{PORT}/api/finances/summary")
        if status[0] != 401:
            raise SystemExit(f"unauthenticated finances {status}")
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
        login = urllib.request.Request(
            f"http://127.0.0.1:{PORT}/login",
            data=b"pin=424242",
            method="POST",
            headers={"Content-Type": "application/x-www-form-urlencoded", "Origin": f"http://127.0.0.1:{PORT}"},
        )
        try:
            opener.open(login, timeout=10).read()
        except urllib.error.HTTPError as exc:
            if exc.code not in (303, 302):
                raise
        me = _json("GET", f"http://127.0.0.1:{PORT}/api/me", opener)
        if me[0] != 200 or me[1].get("role") != "admin":
            raise SystemExit(f"session {me}")
        if not (harness.state / "bridge_sessions.json").is_file():
            raise SystemExit("session was not stored in the state root")
        if (SOURCE / "bridge_sessions.json").exists() and not harness.code_sessions_existed:
            raise SystemExit("session leaked into the code directory")
        finances = _json("GET", f"http://127.0.0.1:{PORT}/api/finances/summary", opener)
        if finances[0] != 404 or finances[1].get("code") != "store_absent":
            raise SystemExit(f"store signal {finances}")
        if (harness.state / ".hq-household").exists() or (harness.state / "inventory.json").exists():
            raise SystemExit("read initialized household storage")
        if (SOURCE / ".hq-household").exists() or (SOURCE / "inventory.json").exists():
            raise SystemExit("storage escaped into the release directory")
        _stop(proc)
        proc = subprocess.Popen(
            [sys.executable, str(BRIDGE)],
            cwd=str(SOURCE),
            env=harness.env(),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        deadline = time.time() + 45
        restarted = None
        while time.time() < deadline:
            if proc.poll() is not None:
                raise SystemExit("restarted bridge exited")
            try:
                restarted = _json("GET", f"http://127.0.0.1:{PORT}/api/me", opener)
                break
            except OSError:
                time.sleep(0.3)
        if not restarted or restarted[0] != 200 or restarted[1].get("role") != "admin":
            raise SystemExit(f"session did not survive restart {restarted}")
    finally:
        _stop(proc)
        harness.close()


def _json(method: str, url: str, opener=None):
    request = urllib.request.Request(url, method=method)
    call = opener.open if opener else urllib.request.urlopen
    try:
        with call(request, timeout=10) as response:
            raw = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        status = exc.code
    try:
        body = json.loads(raw.decode())
    except ValueError:
        body = {"_raw": raw[:200].decode("utf-8", "replace")}
    return status, body


def _stop(proc: subprocess.Popen | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"], capture_output=True, check=False)


def _write_state(path: Path, planner: int) -> None:
    path.mkdir(parents=True, exist_ok=True)
    (path / "bridge_config.json").write_text(json.dumps({
        "pin": "424242",
        "users": [{"name": "admin", "pin": "424242", "role": "admin"}],
        "bind_host": "127.0.0.1",
        "planner_port": planner,
        "backup_auto_paused": True,
        "automation_enabled": False,
        "schedules_enabled": False,
        "push_enabled": False,
        "disk_probe_enabled": False,
        "screenshot_ingest_enabled": False,
        "folders": ["Inbox"],
        "default_folder": "Inbox",
    }), encoding="utf-8")


def _launch(state: Path, port: str) -> subprocess.Popen:
    env = os.environ.copy()
    env["HQ_STATE_ROOT"] = str(state)
    env["HQ_PORT"] = port
    return subprocess.Popen(
        [sys.executable, str(BRIDGE)],
        cwd=str(SOURCE),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )


def _wait_up(proc: subprocess.Popen, port: str) -> None:
    deadline = time.time() + 45
    while time.time() < deadline:
        if proc.poll() is not None:
            output = proc.stdout.read() if proc.stdout else ""
            raise SystemExit(output or f"bridge on {port} exited")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/assets/hq-household-budget.js", timeout=2).read()
            return
        except OSError:
            time.sleep(0.3)
    raise SystemExit(f"bridge did not answer on {port}")


def test_same_state_rejects_second_writer() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-lock-"))
    state = root / "state"
    first = second = None
    try:
        _write_state(state, 18772)
        first = _launch(state, "18771")
        _wait_up(first, "18771")
        sessions = (state / "bridge_sessions.json").read_bytes() if (state / "bridge_sessions.json").is_file() else b""
        second = _launch(state, "18773")
        output, _ = second.communicate(timeout=30)
        if second.returncode == 0 or "already owned" not in output:
            raise SystemExit(output or f"second rc={second.returncode}")
        urllib.request.urlopen(f"http://127.0.0.1:18771/assets/hq-household-budget.js", timeout=5).read()
        after = (state / "bridge_sessions.json").read_bytes() if (state / "bridge_sessions.json").is_file() else b""
        if after != sessions:
            raise SystemExit("second launch changed the session file")
        if (state / ".hq-household").exists() or (state / "inventory.json").exists():
            raise SystemExit("collision created household storage")
    finally:
        _stop(second)
        _stop(first)
        shutil.rmtree(root, ignore_errors=True)


def test_distinct_roots_and_port_collision() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-two-"))
    left = root / "left"
    right = root / "right"
    other = root / "other"
    first = second = collided = None
    try:
        _write_state(left, 18776)
        _write_state(right, 18778)
        _write_state(other, 18780)
        first = _launch(left, "18775")
        second = _launch(right, "18777")
        _wait_up(first, "18775")
        _wait_up(second, "18777")
        collided = _launch(other, "18775")
        output, _ = collided.communicate(timeout=40)
        if collided.returncode == 0 or "Cannot bind" not in output:
            raise SystemExit(output or f"collision rc={collided.returncode}")
        urllib.request.urlopen("http://127.0.0.1:18775/assets/hq-companion.js", timeout=5).read()
        urllib.request.urlopen("http://127.0.0.1:18777/assets/hq-household-budget.js", timeout=5).read()
    finally:
        _stop(collided)
        _stop(second)
        _stop(first)
        shutil.rmtree(root, ignore_errors=True)


def test_validate_only_reads_planner_port() -> None:
    script = SOURCE / "start_release.ps1"
    root = Path(tempfile.mkdtemp(prefix="hq-validate-"))
    try:
        state = root / "state"
        _write_state(state, 8766)
        bad = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(script), "-ReleaseDir", str(SOURCE), "-StateRoot", str(state), "-Port", "18765", "-ValidateOnly"],
            capture_output=True, text=True, timeout=30,
        )
        if bad.returncode == 0 or "8766" not in (bad.stdout + bad.stderr):
            raise SystemExit(bad.stdout + bad.stderr)
        _write_state(state, 18765)
        same = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(script), "-ReleaseDir", str(SOURCE), "-StateRoot", str(state), "-Port", "18765", "-ValidateOnly"],
            capture_output=True, text=True, timeout=30,
        )
        if same.returncode == 0:
            raise SystemExit(same.stdout + same.stderr)
        _write_state(state, 18766)
        good = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(script), "-ReleaseDir", str(SOURCE), "-StateRoot", str(state), "-Port", "18765", "-ValidateOnly"],
            capture_output=True, text=True, timeout=30,
        )
        if good.returncode != 0:
            raise SystemExit(good.stdout + good.stderr)
        if (state / "bridge.lock").exists() or (state / ".hq-household").exists():
            raise SystemExit("validation created application state")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_launcher_refuses_live_workspace() -> None:
    script = SOURCE / "start_release.ps1"
    completed = subprocess.run(
        ["powershell", "-NoProfile", "-File", str(script), "-ReleaseDir", r"C:\Transfert", "-StateRoot", r"C:\Transfert", "-Port", "18765", "-ValidateOnly"],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if completed.returncode == 0:
        raise SystemExit(completed.stdout + completed.stderr)


def main() -> None:
    test_missing_state_is_not_created()
    test_config_is_not_created()
    test_launcher_refuses_live_workspace()
    test_validate_only_reads_planner_port()
    test_same_state_rejects_second_writer()
    test_distinct_roots_and_port_collision()
    test_live_split()
    print("release layout ok")


if __name__ == "__main__":
    main()
