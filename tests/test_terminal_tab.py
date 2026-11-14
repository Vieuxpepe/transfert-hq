"""Terminal tab (view ops): allowlist, truncation flags, clean timeout, shell targets.

The HTML/JS side lives in tests/test_hq_ux_features.py; this module only covers
cc_ext.run_terminal / run_shell / list_shell_targets against a throwaway root.
"""

from __future__ import annotations

import json
import sys
import tempfile
import time
import unittest
from pathlib import Path

import cc_ext

PY = sys.executable


def _config(**extra) -> dict:
    cfg = {
        "terminal_commands": [
            {"id": "hello", "label": "Hello", "cmd": "echo hello"},
            {"id": "flood", "label": "Flood", "cmd": f'"{PY}" -c "print(\'x\' * 9000)"'},
            {"id": "slow", "label": "Slow", "cmd": f'"{PY}" -c "import time; time.sleep(5)"'},
            {"id": "broken", "label": "Broken"},
            {"id": "shape", "label": "Shape", "cmd": ["echo", "nope"]},
        ],
        "terminal_timeout_sec": 20,
        "shell_timeout_sec": 45,
    }
    cfg.update(extra)
    return cfg


class TerminalBackendTests(unittest.TestCase):
    def setUp(self):
        # Jobs run with the root as cwd: Windows can keep the directory busy for a
        # moment after a kill, which must not turn a passing test into a teardown error.
        self.tmp = tempfile.TemporaryDirectory(prefix="hq-terminal-", ignore_cleanup_errors=True)
        self.old_root = cc_ext.ROOT
        self.old_cfg = cc_ext.get_config
        self.cfg = _config()
        cc_ext.bind(ROOT=Path(self.tmp.name), get_config=lambda: self.cfg)

    def tearDown(self):
        # Jobs live in module state: leave none behind, or the next test's cap of
        # JOB_MAX_RUNNING slots is already taken and its command waits as "queued".
        try:
            cc_ext.stop_all_jobs()
        except Exception:
            pass
        with cc_ext._JOBS_LOCK:
            jobs = list(cc_ext._JOBS.values())
            cc_ext._JOBS.clear()
            cc_ext._pending.clear()
        for job in jobs:
            # A killed process can keep the temp root busy: let its reader finish first.
            job.finished.wait(2.0)
        cc_ext.bind(ROOT=self.old_root, get_config=self.old_cfg)
        try:
            self.tmp.cleanup()
        except Exception:
            pass  # a busy directory must not fail a passing test; the janitor sweeps it

    def test_allowlist_by_id_and_exact_raw_only(self):
        by_id = cc_ext.run_terminal(cmd_id="hello")
        self.assertTrue(by_id["ok"])
        self.assertIn("hello", by_id["stdout"])
        self.assertEqual(by_id["label"], "Hello")
        self.assertEqual(by_id["truncated"], {"stdout": False, "stderr": False})
        self.assertIn("duration_ms", by_id)
        self.assertEqual(by_id["timeout_sec"], 20)

        # A raw command is accepted only when it matches an allowlisted cmd string exactly.
        self.assertTrue(cc_ext.run_terminal(raw="echo hello")["ok"])
        with self.assertRaises(ValueError):
            cc_ext.run_terminal(raw="echo nope")
        with self.assertRaises(ValueError):
            cc_ext.run_terminal(cmd_id="unknown")
        with self.assertRaises(ValueError):
            cc_ext.run_terminal()

    def test_malformed_allowlist_entry_is_refused_not_crashed(self):
        with self.assertRaises(ValueError) as ctx:
            cc_ext.run_terminal(cmd_id="broken")  # no cmd at all
        self.assertIn("autoris", str(ctx.exception))
        with self.assertRaises(ValueError):
            cc_ext.run_terminal(cmd_id="shape")  # cmd is a list, not a string

    def test_long_output_is_flagged_and_bounded(self):
        info = cc_ext.run_terminal(cmd_id="flood")
        self.assertLessEqual(len(info["stdout"]), 8000)
        self.assertTrue(info["truncated"]["stdout"])

    def test_timeout_is_a_clean_message(self):
        self.cfg["terminal_timeout_sec"] = 1
        with self.assertRaises(ValueError) as ctx:
            cc_ext.run_terminal(cmd_id="slow")
        message = str(ctx.exception)
        self.assertIn("Délai dépassé", message)
        self.assertNotIn("Command '", message)  # no TimeoutExpired repr with the command line

    def test_run_shell_refuses_raw_locally_and_reports_truncation(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        with self.assertRaises(ValueError):
            cc_ext.run_shell(target=local, shell="raw", command="echo hi")
        info = cc_ext.run_shell(target=local, shell="cmd", command="echo hi")
        self.assertIn("hi", info["stdout"])
        self.assertEqual(info["truncated"], {"stdout": False, "stderr": False})
        self.assertIn("duration_ms", info)

    def _wait(self, job_id: str, *, timeout: float = 10.0) -> dict:
        deadline = time.monotonic() + timeout
        snap = cc_ext.job_snapshot(job_id, 0)
        while snap["state"] == "running" and time.monotonic() < deadline:
            time.sleep(0.05)
            snap = cc_ext.job_snapshot(job_id, 0)
        return snap

    def _wait_done(self, job_id: str, *, timeout: float = 25.0) -> dict:
        """Wait through a queued slot too: parallel tests can leave the queue busy."""
        deadline = time.monotonic() + timeout
        snap = cc_ext.job_snapshot(job_id, 0)
        while snap["state"] in ("running", "queued") and time.monotonic() < deadline:
            time.sleep(0.05)
            snap = cc_ext.job_snapshot(job_id, 0)
        return snap

    def test_job_returns_an_id_and_finishes(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        started = cc_ext.start_shell_job(target=local, shell="cmd", command="echo hq-job-ok")
        self.assertTrue(started["job_id"])
        self.assertIn(started["state"], ("running", "done"))
        snap = self._wait(started["job_id"])
        self.assertEqual(snap["state"], "done")
        self.assertEqual(snap["code"], 0)
        self.assertIn("hq-job-ok", snap["output"])

    def test_job_output_is_incremental(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        cmd = "echo premier & ping -n 3 127.0.0.1 >NUL & echo second"
        job = cc_ext.start_shell_job(target=local, shell="cmd", command=cmd)
        deadline = time.monotonic() + 6
        first = job
        while time.monotonic() < deadline:
            first = cc_ext.job_snapshot(job["job_id"], 0)
            if "premier" in first["output"]:
                break
            time.sleep(0.05)
        self.assertIn("premier", first["output"])
        self.assertNotIn("second", first["output"])
        self.assertEqual(first["state"], "running")
        cursor = first["cursor"]
        snap = self._wait(job["job_id"])
        self.assertIn("second", snap["output"])
        # The cursor only carries what is new.
        delta = cc_ext.job_snapshot(job["job_id"], cursor)
        self.assertIn("second", delta["output"])
        self.assertNotIn("premier", delta["output"])

    def test_stop_kills_the_process_tree(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        job = cc_ext.start_shell_job(target=local, shell="cmd", command="ping -n 20 127.0.0.1")
        time.sleep(0.4)
        self.assertEqual(cc_ext.job_snapshot(job["job_id"])["state"], "running")
        stopped = cc_ext.stop_job(job["job_id"])
        self.assertEqual(stopped["state"], "stopped")
        self.assertIsNotNone(stopped["code"])
        self.assertEqual(cc_ext.job_snapshot(job["job_id"])["state"], "stopped")

    def test_timeout_marks_the_job(self):
        self.cfg["terminal_timeout_sec"] = 1
        job = cc_ext.start_terminal_job(cmd_id="slow")
        snap = self._wait(job["job_id"], timeout=8)
        self.assertEqual(snap["state"], "timeout")
        self.assertIn("Délai dépassé", snap["error"])

    def test_list_jobs_returns_summaries(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        first = cc_ext.start_shell_job(target=local, shell="cmd", command="echo hq-list-one")
        self._wait(first["job_id"])
        second = cc_ext.start_shell_job(target=local, shell="cmd", command="ping -n 5 127.0.0.1")
        jobs = cc_ext.list_jobs()
        ids = [j["job_id"] for j in jobs]
        self.assertEqual(ids[0], second["job_id"])  # newest first
        self.assertIn(first["job_id"], ids)
        self.assertEqual(jobs[0]["state"], "running")
        self.assertNotIn("output", jobs[0])  # the list stays small, transcripts are polled
        self.assertEqual(jobs[0]["label"], second["label"])
        for row in jobs:
            self.assertIn("elapsed_ms", row)
        cc_ext.stop_job(second["job_id"])

    def test_queue_caps_parallel_jobs_and_stop_all(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        jobs = [
            cc_ext.start_shell_job(target=local, shell="cmd", command="ping -n 8 127.0.0.1")
            for _ in range(cc_ext.JOB_MAX_RUNNING + 1)
        ]
        states = [cc_ext.job_snapshot(job["job_id"])["state"] for job in jobs]
        self.assertEqual(states.count("running"), cc_ext.JOB_MAX_RUNNING)
        self.assertEqual(states.count("queued"), 1)
        info = cc_ext.stop_all_jobs()
        self.assertEqual(info["stopped"], cc_ext.JOB_MAX_RUNNING + 1)
        for job in jobs:
            self.assertEqual(cc_ext.job_snapshot(job["job_id"])["state"], "stopped")

    def test_reconcile_marks_leftovers_interrupted(self):
        folder = cc_ext._jobs_dir()
        folder.mkdir(parents=True, exist_ok=True)
        doc = {"version": 1, "job_id": "0123456789abcdef", "state": "running", "pid": 1234, "started": 1, "ended": 1, "output": "ping"}
        (folder / "0123456789abcdef.json").write_text(json.dumps(doc), encoding="utf-8")
        self.assertEqual(cc_ext.reconcile_orphans(), 1)
        snap = cc_ext.job_snapshot("0123456789abcdef", 0)
        self.assertEqual(snap["state"], "interrupted")
        self.assertIn("arrêté", snap["error"])
        self.assertEqual(cc_ext.reconcile_orphans(), 0)  # idempotent

    def test_rows_carry_command_and_target_for_rerun(self):
        cc_ext.stop_all_jobs()  # a leftover job from another test must not queue this one
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        job = cc_ext.start_shell_job(target=local, shell="cmd", command="echo hq-rerun")
        self.assertEqual(self._wait_done(job["job_id"])["state"], "done")
        row = next(r for r in cc_ext.list_jobs() if r["job_id"] == job["job_id"])
        self.assertEqual(row["command"], "echo hq-rerun")
        self.assertEqual(row["target"], "local")
        self.assertEqual(row["shell"], "cmd")
        # The saved copy keeps them too, so ⟳ still works on a row from a previous bridge run.
        doc = cc_ext._persisted_doc(job["job_id"])
        self.assertEqual((doc["command"], doc["target"], doc["shell"]), ("echo hq-rerun", "local", "cmd"))

    def test_stats_and_clear_saved_jobs(self):
        cc_ext.stop_all_jobs()
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        job = cc_ext.start_shell_job(target=local, shell="cmd", command="echo hq-stats-ok")
        self.assertEqual(self._wait_done(job["job_id"])["state"], "done")
        stats = cc_ext.job_stats()
        self.assertGreaterEqual(stats["total"], 1)
        self.assertGreaterEqual(stats["ok"], 1)
        self.assertTrue(stats["commands"])
        self.assertGreaterEqual(cc_ext.persisted_stats()["count"], 1)
        self.assertGreaterEqual(cc_ext.clear_persisted()["deleted"], 1)
        self.assertEqual(cc_ext.persisted_stats()["count"], 0)

    def test_finished_job_survives_a_restart(self):
        local = {"id": "local", "label": "Ce PC", "type": "local"}
        job = cc_ext.start_shell_job(target=local, shell="cmd", command="echo hq-persist-ok")
        self._wait(job["job_id"])
        cc_ext._JOBS.clear()  # a restart: memory is gone, the file on disk is not
        self.assertIn(job["job_id"], [j["job_id"] for j in cc_ext.list_jobs()])
        snap = cc_ext.job_snapshot(job["job_id"], 0)
        self.assertEqual(snap["state"], "done")
        self.assertIn("hq-persist-ok", snap["output"])
        self.assertEqual(cc_ext.stop_job(job["job_id"])["state"], "done")  # nothing left to kill
        # The transcript is only sent on a first read.
        self.assertEqual(cc_ext.job_snapshot(job["job_id"], snap["cursor"])["output"], "")

    def test_unknown_job_is_a_key_error(self):
        with self.assertRaises(KeyError):
            cc_ext.job_snapshot("nope", 0)
        with self.assertRaises(KeyError):
            cc_ext.stop_job("nope")

    def test_targets_carry_os_and_unknown_state(self):
        self.cfg["shell_targets"] = [
            {"id": "local", "label": "Ce PC", "type": "local"},
            {"id": "nas", "label": "NAS", "type": "ssh", "host": "100.64.0.9", "os": "linux"},
        ]
        peers = [
            {"name": "mac-mini", "os": "macOS", "ip": "100.64.0.10", "online": True},
            {"name": "iphone", "os": "iOS", "ip": "100.64.0.11", "online": True},
        ]
        targets = {t["id"]: t for t in cc_ext.list_shell_targets(tailscale_peers_fn=lambda: peers)}
        self.assertTrue(targets["local"]["online"])
        self.assertEqual(targets["local"]["os"], "")
        self.assertEqual(targets["nas"]["os"], "linux")
        self.assertIsNone(targets["nas"]["online"])  # declared, never probed
        self.assertEqual(targets["ts-mac-mini"]["type"], "ssh")
        self.assertEqual(targets["ts-mac-mini"]["os"], "macOS")
        self.assertNotIn("ts-iphone", targets)  # phones never get a remote shell


if __name__ == "__main__":
    unittest.main()
