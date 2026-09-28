"""Regression tests: browser-presence offline alerts must not deadlock cc_ext.

note_presence_snapshot() used to call push_alert() while holding cc_ext._lock
(a non-reentrant threading.Lock); push_alert() takes the same lock, so the
monitor thread froze forever and every alerts/activity reader blocked behind it.

Offline only: no live bridge, no Discord, controlled clock, isolated module state.
Each blocking call runs in a daemon thread with a short join timeout so a
regression fails fast instead of hanging the suite.
"""

from __future__ import annotations

import shutil
import tempfile
import threading
import time as real_time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import cc_ext
import hq_automation
import hq_events

JOIN_TIMEOUT = 2.0
NOW = 1_800_000_000.0
OFFLINE_TITLE = "Appareil hors ligne"


def _browser(pid: str, name: str | None, last_seen: float) -> dict:
    return {"id": pid, "name": name, "source": "browser", "last_seen": last_seen}


class PresenceDeadlockTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-cc-presence-"))
        self.clock = [NOW]
        self.discord: list[tuple[str, str]] = []
        saved = {
            name: getattr(cc_ext, name)
            for name in ("_lock", "_activity", "_alerts", "_seen_presence", "ROOT", "notify_discord", "get_config", "time")
        }

        def restore():
            for name, value in saved.items():
                setattr(cc_ext, name, value)

        self.addCleanup(restore)
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        # Fresh lock per test: if a regression deadlocks a worker thread, it only
        # holds this throwaway lock and cannot freeze later tests.
        cc_ext._lock = threading.Lock()
        cc_ext._activity = []
        cc_ext._alerts = []
        cc_ext._seen_presence = {}
        cc_ext.ROOT = self.tmp
        cc_ext.notify_discord = lambda title, detail: self.discord.append((title, detail))
        cc_ext.get_config = lambda: {}
        # Controlled clock for cc_ext only (the real time module stays untouched).
        cc_ext.time = SimpleNamespace(time=lambda: self.clock[0], sleep=real_time.sleep)
        # Keep other modules' global state (possibly bound by earlier tests) out of the picture.
        for patcher in (
            mock.patch.object(hq_events, "enabled", return_value=False),
            mock.patch.object(hq_automation, "ready", return_value=False),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def run_bounded(self, fn, *args):
        """Run fn in a daemon thread; fail (instead of hanging) if it doesn't finish."""
        box: dict = {}

        def target():
            try:
                box["result"] = fn(*args)
            except BaseException as exc:  # pragma: no cover - surfaced below
                box["error"] = exc

        worker = threading.Thread(target=target, daemon=True)
        worker.start()
        worker.join(JOIN_TIMEOUT)
        self.assertFalse(worker.is_alive(), f"{getattr(fn, '__name__', fn)} blocked > {JOIN_TIMEOUT}s (deadlock)")
        if "error" in box:
            raise box["error"]
        return box.get("result")

    def offline_alerts(self) -> list[dict]:
        return [a for a in self.run_bounded(cc_ext.alerts_list) if a["title"] == OFFLINE_TITLE]

    def test_offline_transition_alerts_once_without_deadlock(self):
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-1", "iPhone Emie", NOW - 5)])
        self.assertEqual(self.offline_alerts(), [])
        self.clock[0] = NOW + 30  # still inside the 600 s window
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        alerts = self.offline_alerts()
        self.assertEqual(len(alerts), 1)
        self.assertEqual(alerts[0]["detail"], "**iPhone Emie** ne répond plus")
        self.assertEqual(self.discord, [(OFFLINE_TITLE, "**iPhone Emie** ne répond plus")])
        self.assertNotIn("b-1", cc_ext._seen_presence)

        # Same empty snapshot again: no duplicate alert for the same transition.
        self.clock[0] = NOW + 50
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        self.assertEqual(len(self.offline_alerts()), 1)
        self.assertEqual(len(self.discord), 1)

    def test_readers_stay_responsive_after_transition(self):
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-1", "Pixel", NOW - 1)])
        self.clock[0] = NOW + 10
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        alerts = self.run_bounded(cc_ext.alerts_list)
        activity = self.run_bounded(cc_ext.activity_list)
        self.assertEqual([a["title"] for a in alerts], [OFFLINE_TITLE])
        self.assertTrue(any(e["kind"] == "alert" and "Pixel" in e["message"] for e in activity))
        # The lock is free again: other writers work too.
        self.run_bounded(cc_ext.log_activity, "upload", "fichier.txt")
        self.run_bounded(cc_ext.push_alert, "Test", "après transition")
        self.assertEqual(len(self.run_bounded(cc_ext.alerts_list)), 2)

    def test_multiple_devices_offline_one_alert_each(self):
        self.run_bounded(
            cc_ext.note_presence_snapshot,
            [_browser("b-1", "iPhone", NOW - 2), _browser("b-2", None, NOW - 3), _browser("b-3", "iPad", NOW - 4)],
        )
        self.clock[0] = NOW + 20
        # b-3 is still present; b-1 and b-2 disappear.
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-3", "iPad", NOW + 19)])
        details = sorted(a["detail"] for a in self.offline_alerts())
        # a nameless device falls back to its id, exactly as before
        self.assertEqual(details, ["**b-2** ne répond plus", "**iPhone** ne répond plus"])
        self.assertEqual(set(cc_ext._seen_presence), {"b-3"})
        self.clock[0] = NOW + 40
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-3", "iPad", NOW + 39)])
        self.assertEqual(len(self.offline_alerts()), 2)

    def test_stale_device_keeps_existing_behavior(self):
        # Behavior on main: a device whose last_seen is >= 600 s old when it disappears
        # gets no alert and stays in _seen_presence (it is not popped).
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-old", "Vieux Mac", NOW - 700)])
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        self.assertEqual(self.offline_alerts(), [])
        self.assertEqual(self.discord, [])
        self.assertIn("b-old", cc_ext._seen_presence)
        self.clock[0] = NOW + 5
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        self.assertEqual(self.offline_alerts(), [])

    def test_device_back_online_can_alert_again(self):
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-1", "iPhone", NOW)])
        self.clock[0] = NOW + 20
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        self.clock[0] = NOW + 40
        self.run_bounded(cc_ext.note_presence_snapshot, [_browser("b-1", "iPhone", NOW + 40)])
        self.clock[0] = NOW + 60
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        self.assertEqual(len(self.offline_alerts()), 2)

    def test_non_browser_devices_are_ignored(self):
        self.run_bounded(
            cc_ext.note_presence_snapshot,
            [{"id": "pc-host", "source": "host", "last_seen": NOW}, {"id": "t-1", "source": "tailscale", "last_seen": NOW}],
        )
        self.run_bounded(cc_ext.note_presence_snapshot, [])
        self.assertEqual(self.offline_alerts(), [])
        self.assertEqual(cc_ext._seen_presence, {})


if __name__ == "__main__":
    unittest.main()
