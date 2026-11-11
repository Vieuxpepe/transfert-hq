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
            extra = "".join(getattr(proc, "_hq_output", []))
            raise SystemExit(output or extra or f"bridge on {port} exited")
        try:
            urllib.request.urlopen(f"http://127.0.0.1:{port}/assets/hq-household-budget.js", timeout=2).read()
            return
        except OSError:
            time.sleep(0.3)
    extra = "".join(getattr(proc, "_hq_output", []))[-1500:]
    raise SystemExit(f"bridge did not answer on {port}\n{extra}")


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
        if collided.returncode == 0 or "Cannot bind 127.0.0.1:18775" not in output:
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


def _launch_script(state: Path, port: str, creationflags: int, *, production_owner: bool = False) -> subprocess.Popen:
    command = ["powershell", "-NoProfile", "-NonInteractive", "-File", str(SOURCE / "start_release.ps1"),
               "-ReleaseDir", str(SOURCE), "-StateRoot", str(state), "-Port", port]
    if production_owner:
        command.append("-ProductionOwner")
    proc = subprocess.Popen(
        command,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        creationflags=creationflags,
    )
    proc._hq_output = []

    def _drain() -> None:
        if proc.stdout is None:
            return
        for line in proc.stdout:
            proc._hq_output.append(line)

    import threading
    threading.Thread(target=_drain, daemon=True).start()
    return proc


def _request_console_stop(proc: subprocess.Popen) -> None:
    """Ctrl+C on the launcher's own console, which the bridge handles as a normal stop."""
    import ctypes
    kernel = ctypes.windll.kernel32
    kernel.FreeConsole()
    if not kernel.AttachConsole(proc.pid):
        raise SystemExit(f"could not attach to the launcher console ({ctypes.get_last_error()})")
    kernel.SetConsoleCtrlHandler(None, True)
    sent = bool(kernel.GenerateConsoleCtrlEvent(0, 0))
    time.sleep(1)
    kernel.FreeConsole()
    kernel.SetConsoleCtrlHandler(None, False)
    if not kernel.AttachConsole(0xFFFFFFFF):
        kernel.AllocConsole()
    if not sent:
        raise SystemExit("could not signal the launcher")


def test_launcher_propagates_exit_code() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-launcher-exit-"))
    live = root / "live"
    other = root / "other"
    first = collided = None
    port = "18881"
    try:
        _write_state(live, 18882)
        _write_state(other, 18884)
        sessions = b'{"synthetic-rehearsal":{"exp":9999999999,"user":"admin","role":"admin","gen":0}}'
        (live / "bridge_sessions.json").write_bytes(sessions)
        (other / "bridge_sessions.json").write_bytes(sessions)
        missing = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(SOURCE / "start_release.ps1"), "-ValidateOnly"],
            capture_output=True, encoding="utf-8", errors="replace", timeout=20,
        )
        if missing.returncode == 0:
            raise SystemExit(missing.stdout + missing.stderr)
        valid = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(SOURCE / "start_release.ps1"),
             "-ReleaseDir", str(SOURCE), "-StateRoot", str(live), "-Port", port, "-ValidateOnly"],
            capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        if valid.returncode != 0:
            raise SystemExit(valid.stdout + valid.stderr)
        first = _launch_script(live, port, subprocess.CREATE_NEW_CONSOLE)
        _wait_up(first, port)
        collided = _launch_script(other, port, subprocess.CREATE_NEW_PROCESS_GROUP)
        try:
            collided.wait(timeout=40)
        except subprocess.TimeoutExpired:
            raise SystemExit("launcher collision did not exit")
        output = "".join(collided._hq_output)
        if collided.returncode != 1 or "Cannot bind 127.0.0.1:18881" not in output:
            raise SystemExit(output or f"launcher collision rc={collided.returncode}")
        urllib.request.urlopen(f"http://127.0.0.1:{port}/assets/hq-household-budget.js", timeout=5).read()
        if (live / "bridge_sessions.json").read_bytes() != sessions or (other / "bridge_sessions.json").read_bytes() != sessions:
            raise SystemExit("failed launch changed session data")
        for state in (live, other):
            if (state / ".hq-household").exists() or (state / "inventory.json").exists():
                raise SystemExit("failed launch created household storage")
        _request_console_stop(first)
        try:
            first.wait(timeout=20)
        except subprocess.TimeoutExpired:
            raise SystemExit("controlled shutdown did not return")
        if first.returncode != 0 or "Stopped." not in "".join(first._hq_output):
            raise SystemExit(f"controlled shutdown rc={first.returncode}\n{''.join(first._hq_output)[-1500:]}")
    finally:
        _stop(collided)
        _stop(first)
        shutil.rmtree(root, ignore_errors=True)


def _lock_is_free(path: Path) -> bool:
    import msvcrt
    if not path.is_file():
        return True
    handle = path.open("r+b")
    try:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        return True
    except OSError:
        return False
    finally:
        handle.close()


def test_production_owner_port_policy() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-owner-policy-"))
    state = root / "state"
    try:
        if str(root).lower().startswith("c:\\transfert\\"):
            raise SystemExit("policy test is inside the live workspace")
        _write_state(state, 18822)
        before = (state / "bridge_config.json").read_bytes()
        script = (
            "import iphone_bridge as bridge\n"
            "bridge.side_by_side_ports_ok(8765, 8766, production_owner=False)\n"
        )
        refused = subprocess.run(
            [sys.executable, "-c", script],
            cwd=str(SOURCE),
            env={**os.environ, "HQ_STATE_ROOT": str(state), "HQ_PORT": "18821", "HQ_PRODUCTION_OWNER": ""},
            capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        # Import succeeds. The call raises SystemExit, which is a nonzero process only if uncaught.
        # The snippet does not catch it, so refusal is a nonzero exit that never binds.
        if refused.returncode == 0:
            raise SystemExit(refused.stdout + refused.stderr)
        allowed = subprocess.run(
            [sys.executable, "-c",
             "import iphone_bridge as bridge\n"
             "bridge.side_by_side_ports_ok(8765, 8766, production_owner=True)\n"
             "try:\n"
             "    bridge.side_by_side_ports_ok(8765, 8765, production_owner=True)\n"
             "except SystemExit:\n"
             "    pass\n"
             "else:\n"
             "    raise SystemExit('equal ports were accepted')\n"
             "import os\n"
             "os.environ['HQ_PRODUCTION_OWNER'] = 'yes'\n"
             "try:\n"
             "    bridge.production_owner_mode()\n"
             "except SystemExit as exc:\n"
             "    if 'must be 1' not in str(exc):\n"
             "        raise\n"
             "else:\n"
             "    raise SystemExit('invalid mode accepted')\n"
             "print('policy ok')\n"],
            cwd=str(SOURCE),
            env={**os.environ, "HQ_STATE_ROOT": str(state), "HQ_PORT": "18821"},
            capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        if allowed.returncode != 0 or "policy ok" not in allowed.stdout:
            raise SystemExit(allowed.stdout + allowed.stderr)
        fresh = root / "invalid"
        _write_state(fresh, 18824)
        before = (fresh / "bridge_config.json").read_bytes()
        invalid = subprocess.run(
            [sys.executable, "-c", "import iphone_bridge"],
            cwd=str(SOURCE),
            env={**os.environ, "HQ_STATE_ROOT": str(fresh), "HQ_PORT": "18823", "HQ_PRODUCTION_OWNER": "yes"},
            capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        if invalid.returncode == 0 or "must be 1" not in (invalid.stdout + invalid.stderr):
            raise SystemExit(invalid.stdout + invalid.stderr)
        if (fresh / "bridge_config.json").read_bytes() != before:
            raise SystemExit("invalid mode modified bridge_config.json")
        if (fresh / ".hq-household").exists() or (fresh / ".hq-inventory").exists() or (fresh / "bridge.lock").exists():
            raise SystemExit("invalid mode created runtime state")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_production_owner_launcher_and_collisions() -> None:
    root = Path(tempfile.mkdtemp(prefix="hq-owner-collide-"))
    live = root / "live"
    other = root / "other"
    third = root / "third"
    first = http_hit = planner_hit = None
    try:
        if str(root).lower().startswith("c:\\transfert\\"):
            raise SystemExit("collision test is inside the live workspace")
        _write_state(live, 18942)
        _write_state(other, 18944)
        _write_state(third, 18942)
        sessions = b'{"synthetic-owner":{"exp":9999999999,"user":"admin","role":"admin","gen":0}}'
        for path in (live, other, third):
            (path / "bridge_sessions.json").write_bytes(sessions)
        other_config = (other / "bridge_config.json").read_bytes()
        third_config = (third / "bridge_config.json").read_bytes()
        ports = root / "ports"
        _write_state(ports, 8766)
        script = SOURCE / "start_release.ps1"
        leaked = os.environ.copy()
        leaked["HQ_PRODUCTION_OWNER"] = "1"
        staging = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(script), "-ReleaseDir", str(SOURCE),
             "-StateRoot", str(ports), "-Port", "8765", "-ValidateOnly"],
            capture_output=True, encoding="utf-8", errors="replace", timeout=30, env=leaked,
        )
        if staging.returncode == 0:
            raise SystemExit(staging.stdout + staging.stderr)
        owned = subprocess.run(
            ["powershell", "-NoProfile", "-File", str(script), "-ReleaseDir", str(SOURCE),
             "-StateRoot", str(ports), "-Port", "8765", "-ValidateOnly", "-ProductionOwner"],
            capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        if owned.returncode != 0:
            raise SystemExit(owned.stdout + owned.stderr)
        if (ports / "bridge.lock").exists() or (ports / ".hq-household").exists() or (ports / ".hq-inventory").exists():
            raise SystemExit("production-owner validation created runtime state")
        first = _launch_script(live, "18941", subprocess.CREATE_NEW_PROCESS_GROUP, production_owner=True)
        _wait_up(first, "18941")
        http_hit = _launch_script(other, "18941", subprocess.CREATE_NEW_PROCESS_GROUP, production_owner=True)
        try:
            http_hit.wait(timeout=40)
        except subprocess.TimeoutExpired:
            raise SystemExit("http collision did not exit")
        http_out = "".join(http_hit._hq_output)
        if http_hit.returncode != 1 or "Cannot bind" not in http_out:
            raise SystemExit(http_out or f"http collision rc={http_hit.returncode}")
        urllib.request.urlopen("http://127.0.0.1:18941/assets/hq-household-budget.js", timeout=5).read()
        if (other / "bridge_config.json").read_bytes() != other_config or (other / "bridge_sessions.json").read_bytes() != sessions:
            raise SystemExit("http collision modified persistent state")
        if not _lock_is_free(other / "bridge.lock"):
            raise SystemExit("http collision kept the state lock")
        planner_hit = _launch_script(third, "18943", subprocess.CREATE_NEW_PROCESS_GROUP, production_owner=True)
        try:
            planner_hit.wait(timeout=40)
        except subprocess.TimeoutExpired:
            raise SystemExit("planner collision did not exit")
        planner_out = "".join(planner_hit._hq_output)
        if planner_hit.returncode == 0 or "planner" not in planner_out.lower():
            raise SystemExit(planner_out or f"planner collision rc={planner_hit.returncode}")
        urllib.request.urlopen("http://127.0.0.1:18941/assets/hq-companion.js", timeout=5).read()
        if (third / "bridge_config.json").read_bytes() != third_config or (third / "bridge_sessions.json").read_bytes() != sessions:
            raise SystemExit("planner collision modified persistent state")
        if (third / ".hq-agent-state").exists() or (third / ".hq-household").exists() or (third / ".hq-inventory").exists():
            raise SystemExit("planner collision created runtime storage")
        if not _lock_is_free(third / "bridge.lock"):
            raise SystemExit("planner collision kept the state lock")
        if (live / "bridge_sessions.json").read_bytes() != sessions:
            raise SystemExit("collisions changed the running session file")
    finally:
        _stop(planner_hit)
        _stop(http_hit)
        _stop(first)
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
    test_launcher_propagates_exit_code()
    test_production_owner_port_policy()
    test_production_owner_launcher_and_collisions()
    test_same_state_rejects_second_writer()
    test_distinct_roots_and_port_collision()
    test_live_split()
    print("release layout ok")


if __name__ == "__main__":
    main()
