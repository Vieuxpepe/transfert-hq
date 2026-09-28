"""Disk alert, disk health and backup-target tests for the HQ-root volume.

The live HQ root is C:\\Transfert. The monitor alert used to watch a hard-coded D:,
so a missing D: silently disabled it and a full C: never alerted.

Offline only: fake disk_free keyed by drive, isolated cc_ext module state, no
Discord, no live bridge, no real backups outside a temp dir.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import threading
import unittest
from pathlib import Path, PurePosixPath, PureWindowsPath
from unittest import mock

import cc_ext
import hq_automation
import hq_calendar
import hq_events
import iphone_bridge

GB = 1024**3
STATE = (
    "_lock", "_activity", "_alerts", "ROOT", "human_size", "notify_discord", "disk_free", "get_config",
    "_disk_alerted", "_disk_missing_alerted", "_backup_alerted", "_last_backup",
)
REAL_MKDIR = Path.mkdir


def guarded_mkdir(test_root: Path):
    """Path.mkdir that refuses anything outside the test's temp dir.

    run_backup() creates its destination with Path.mkdir before copying anything, so
    this stops a test from ever writing a real backup (e.g. to D: on a Windows PC
    where D:/Backups/Transfert is an absolute, existing path)."""
    root = os.path.abspath(str(test_root))

    def mkdir(path, *args, **kwargs):
        target = os.path.abspath(str(path))
        try:
            inside = os.path.commonpath([root, target]) == root
        except ValueError:  # different drives on Windows
            inside = False
        if not inside:
            raise AssertionError(f"test tried to create a directory outside its temp dir: {path}")
        return REAL_MKDIR(path, *args, **kwargs)

    return mkdir


def disk(free_gb: float, total_gb: float = 500.0) -> dict:
    return {"free": int(free_gb * GB), "total": int(total_gb * GB), "free_h": f"{free_gb:g} Go", "total_h": f"{total_gb:g} Go"}


MISSING = {"error": "[WinError 3] Le chemin d'accès spécifié est introuvable"}


class FakeDisks:
    """disk_free() stand-in: answers by drive letter of the queried path."""

    def __init__(self, **drives: dict):
        self.drives = drives
        self.calls: list[str] = []

    def __call__(self, path) -> dict:
        text = str(path)
        self.calls.append(text)
        letter = text[:1].upper() if text[1:2] == ":" else "ROOT"
        return dict(self.drives.get(letter, MISSING))


class DiskTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-disk-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        saved = {name: getattr(cc_ext, name, None) for name in STATE}

        def restore():
            for name, value in saved.items():
                setattr(cc_ext, name, value)

        self.addCleanup(restore)
        self.cfg: dict = {"alert_disk_min_gb": 20}
        self.discord: list[tuple[str, str]] = []
        cc_ext._lock = threading.Lock()
        cc_ext._activity = []
        cc_ext._alerts = []
        cc_ext._disk_alerted = False
        cc_ext._disk_missing_alerted = False
        cc_ext._backup_alerted = False
        cc_ext._last_backup = 0.0
        cc_ext.ROOT = PureWindowsPath(r"C:\Transfert")  # the live layout
        cc_ext.human_size = lambda n: f"{n / GB:.1f} Go"
        cc_ext.notify_discord = lambda title, detail: self.discord.append((title, detail))
        cc_ext.get_config = lambda: self.cfg
        cc_ext.disk_free = FakeDisks(C=disk(200), D=disk(900))
        for patcher in (
            mock.patch.object(hq_events, "enabled", return_value=False),
            mock.patch.object(hq_automation, "ready", return_value=False),
            mock.patch.object(cc_ext, "_persist_activity", lambda: None),  # ROOT is a PureWindowsPath
            mock.patch.object(Path, "mkdir", guarded_mkdir(self.tmp)),  # never write outside tmp (e.g. D:)
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def alerts(self, title: str) -> list[dict]:
        return [a for a in cc_ext.alerts_list() if a["title"] == title]


class DiskAlertTests(DiskTestBase):
    def test_low_space_on_root_volume_alerts_once_and_names_drive(self):
        cc_ext.disk_free = FakeDisks(C=disk(5), D=disk(900))
        cc_ext.check_disk_alert()
        cc_ext.check_disk_alert()
        low = self.alerts("Espace disque bas")
        self.assertEqual(len(low), 1, "alert once, no duplicate on repeat")
        self.assertEqual(low[0]["detail"], "C: libre: **5.0 Go** (seuil 20.0 Go)")
        self.assertEqual(self.discord, [("Espace disque bas", "C: libre: **5.0 Go** (seuil 20.0 Go)")])
        self.assertTrue(any(c.startswith("C:") for c in cc_ext.disk_free.calls))

    def test_d_drive_no_longer_drives_the_alert(self):
        cc_ext.disk_free = FakeDisks(C=disk(200), D=disk(1))
        cc_ext.check_disk_alert()
        self.assertEqual(self.alerts("Espace disque bas"), [])
        self.assertFalse(any(c.startswith("D:") for c in cc_ext.disk_free.calls), cc_ext.disk_free.calls)

    def test_recovery_rearms_like_main(self):
        cc_ext.disk_free = FakeDisks(C=disk(5))
        cc_ext.check_disk_alert()
        cc_ext.disk_free.drives["C"] = disk(50)  # back above the threshold -> re-armed
        cc_ext.check_disk_alert()
        self.assertFalse(cc_ext._disk_alerted)
        cc_ext.disk_free.drives["C"] = disk(5)
        cc_ext.check_disk_alert()
        self.assertEqual(len(self.alerts("Espace disque bas")), 2)

    def test_full_disk_with_zero_free_bytes_alerts(self):
        cc_ext.disk_free = FakeDisks(C=disk(0))
        cc_ext.check_disk_alert()
        self.assertEqual(len(self.alerts("Espace disque bas")), 1)

    def test_missing_root_volume_warns_once_and_is_not_treated_as_fine(self):
        cc_ext.disk_free = FakeDisks(C=disk(5))
        cc_ext.check_disk_alert()  # low -> alerted
        cc_ext.disk_free.drives.pop("C")  # volume becomes unreadable
        for _ in range(3):
            cc_ext.check_disk_alert()
        missing = self.alerts("Disque introuvable")
        self.assertEqual(len(missing), 1, "one warning, no spam")
        self.assertIn("C: illisible", missing[0]["detail"])
        self.assertIn("introuvable", missing[0]["detail"])
        self.assertTrue(cc_ext._disk_alerted, "unknown state must not re-arm/clear the low-space alert")
        cc_ext.disk_free.drives["C"] = disk(5)  # readable again, still low: no duplicate low alert
        cc_ext.check_disk_alert()
        self.assertEqual(len(self.alerts("Espace disque bas")), 1)
        cc_ext.disk_free.drives.pop("C")  # missing again after recovery -> warns again
        cc_ext.check_disk_alert()
        self.assertEqual(len(self.alerts("Disque introuvable")), 2)

    def test_volume_label(self):
        self.assertEqual(cc_ext.volume_label(PureWindowsPath(r"C:\Transfert")), "C:")
        self.assertEqual(cc_ext.volume_label(PureWindowsPath(r"E:\HQ\Transfert")), "E:")
        self.assertEqual(cc_ext.volume_label(PureWindowsPath(r"\\nas\share\Transfert")), "\\\\nas\\share")
        self.assertEqual(cc_ext.volume_label(PurePosixPath("/srv/transfert")), "/")


class HealthTests(DiskTestBase):
    def test_health_report_has_root_volume_and_flags_missing_d(self):
        cc_ext.disk_free = FakeDisks(C=disk(120))  # no D: drive
        with mock.patch.object(cc_ext, "smb_share_ok", return_value=False):
            rep = cc_ext.health_report(uptime_sec=5, tailscale_ip=None, version="7.0")
        self.assertEqual(rep["disk_root"]["volume"], "C:")
        self.assertEqual(rep["disk_root"]["free"], 120 * GB)
        self.assertNotIn("missing", rep["disk_root"])
        self.assertIn("disk_d", rep, "kept for older clients")
        self.assertTrue(rep["disk_d"]["missing"])
        self.assertEqual(rep["disk_d"]["volume"], "D:")
        self.assertTrue(rep["disk_d"]["error"])
        self.assertIn("backup", rep)

    def test_health_report_keeps_d_values_when_present(self):
        cc_ext.disk_free = FakeDisks(C=disk(120), D=disk(900))
        with mock.patch.object(cc_ext, "smb_share_ok", return_value=False):
            rep = cc_ext.health_report(uptime_sec=5, tailscale_ip=None, version="7.0")
        self.assertEqual(rep["disk_d"]["free"], 900 * GB)
        self.assertEqual(rep["disk_d"]["free_h"], "900 Go")
        self.assertNotIn("missing", rep["disk_d"])

    def _host_entry(self, root, fake):
        with mock.patch.object(iphone_bridge, "ROOT", root), mock.patch.object(iphone_bridge, "disk_free", fake), \
                mock.patch.object(iphone_bridge, "lan_ipv4", return_value="192.168.1.10"):
            return iphone_bridge.host_device_entry()

    def test_host_entry_primary_is_root_volume(self):
        entry = self._host_entry(PureWindowsPath(r"C:\Transfert"), FakeDisks(C=disk(120), D=disk(900)))
        self.assertEqual(entry["free"], 120 * GB, "primary = HQ-root volume, not D:")
        self.assertEqual([d["name"] for d in entry["disks"]], ["C:", "D:"])

    def test_host_entry_without_d_and_on_other_root_drive(self):
        entry = self._host_entry(PureWindowsPath(r"C:\Transfert"), FakeDisks(C=disk(120)))
        self.assertEqual([d["name"] for d in entry["disks"]], ["C:"])
        self.assertEqual(entry["free"], 120 * GB)
        entry = self._host_entry(PureWindowsPath(r"E:\Transfert"), FakeDisks(C=disk(120), E=disk(40)))
        self.assertEqual([d["name"] for d in entry["disks"]], ["E:", "C:"])
        self.assertEqual(entry["free"], 40 * GB)

    def test_bridge_status_marks_volumes(self):
        with mock.patch.object(iphone_bridge, "ROOT", PureWindowsPath(r"C:\Transfert")), \
                mock.patch.object(iphone_bridge, "disk_free", FakeDisks(C=disk(120))), \
                mock.patch.object(iphone_bridge, "lan_ipv4", return_value="192.168.1.10"), \
                mock.patch.object(iphone_bridge, "tailscale_ipv4", return_value=None):
            st = iphone_bridge.bridge_status()
        self.assertEqual(st["disk_transfert"]["volume"], "C:")
        self.assertEqual(st["disk_transfert"]["free_h"], "120 Go")
        self.assertTrue(st["disk_d"]["missing"])

    def test_wallboard_health_line_uses_root_volume(self):
        html = iphone_bridge.render_wallboard().decode("utf-8")
        self.assertIn("h.disk_root", html)
        self.assertNotIn("' · D: ' + (h.disk_d?.free_h", html)


class BackupTargetTests(DiskTestBase):
    def setUp(self):
        super().setUp()
        cc_ext.ROOT = self.tmp / "Transfert"
        (cc_ext.ROOT / "Inbox").mkdir(parents=True)
        (cc_ext.ROOT / "Inbox" / "a.txt").write_text("x", encoding="utf-8")
        cwd = os.getcwd()
        os.chdir(self.tmp)  # a relative default must never land in the repo
        self.addCleanup(os.chdir, cwd)

    def test_default_backup_dir_is_not_moved_to_root_volume(self):
        self.assertEqual(cc_ext.DEFAULT_BACKUP_DIR, "D:/Backups/Transfert")
        self.assertEqual(iphone_bridge.default_config()["backup_dir"], "D:/Backups/Transfert")
        self.assertEqual(cc_ext.backup_target_status()["dir"], "D:/Backups/Transfert")

    def test_missing_backup_drive_fails_explicitly(self):
        self.cfg["backup_dir"] = str(self.tmp / "nodrive" / "Backups")
        with mock.patch.object(cc_ext, "_volume_present", return_value=False, create=True):
            status = cc_ext.backup_target_status()
            with self.assertRaises(RuntimeError) as cm:
                cc_ext.run_backup(force=True)
        self.assertFalse(status["ok"])
        self.assertIn("introuvable", str(cm.exception))
        self.assertFalse((self.tmp / "nodrive").exists(), "nothing written elsewhere")
        self.assertEqual(sorted(p.name for p in cc_ext.ROOT.iterdir()), ["Inbox"], "never falls back to ROOT")

    def test_unusable_default_never_writes_relative_or_to_root(self):
        # Default target D:/Backups/Transfert made unusable: on POSIX it is not absolute; on
        # Windows the missing-volume check is mocked (the PC running the suite may really have
        # a D: drive). Either way the backup must fail instead of writing somewhere else.
        with mock.patch.object(cc_ext, "_volume_present", return_value=False, create=True):
            with self.assertRaises(RuntimeError):
                cc_ext.run_backup(force=True)
        # Nothing new next to ROOT (a relative "D:" folder on POSIX, or anything else);
        # listing the temp dir avoids Path("D:") meaning "current dir of drive D:" on Windows.
        self.assertEqual(sorted(os.listdir(self.tmp)), ["Transfert"])
        self.assertEqual(sorted(p.name for p in cc_ext.ROOT.iterdir()), ["Inbox"])

    def test_scheduled_backup_failure_alerts_once_and_rearms(self):
        self.cfg["backup_dir"] = str(self.tmp / "bk")
        with mock.patch.object(cc_ext, "_volume_present", return_value=False, create=True):
            for _ in range(3):
                cc_ext.maybe_backup()
        failed = self.alerts("Backup impossible")
        self.assertEqual(len(failed), 1, "one visible alert, not one per monitor tick")
        self.assertIn("introuvable", failed[0]["detail"])
        cc_ext.maybe_backup()  # drive back: backup succeeds and re-arms
        self.assertTrue(any((self.tmp / "bk").iterdir()))
        self.assertFalse(cc_ext._backup_alerted)
        cc_ext._last_backup = 0.0
        with mock.patch.object(cc_ext, "_volume_present", return_value=False, create=True):
            cc_ext.maybe_backup()
        self.assertEqual(len(self.alerts("Backup impossible")), 2)


class BackupPauseTests(DiskTestBase):
    """backup_auto_paused: no automatic backup touches any target; manual backup still works."""

    def setUp(self):
        super().setUp()
        cc_ext.ROOT = self.tmp / "Transfert"
        (cc_ext.ROOT / "Inbox").mkdir(parents=True)
        (cc_ext.ROOT / "Inbox" / "a.txt").write_text("x", encoding="utf-8")
        cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        self.bk = self.tmp / "bk"
        self.cfg["backup_dir"] = str(self.bk)
        self.cfg["backup_auto_paused"] = True

    def spies(self, volume_present: bool = True):
        """Spy every way run_backup reaches a backup target (probe, mkdir, copytree)."""
        mkdirs: list[str] = []

        guarded = guarded_mkdir(self.tmp)

        def spy_mkdir(path, *args, **kwargs):
            mkdirs.append(str(path))
            return guarded(path, *args, **kwargs)

        present = mock.Mock(return_value=volume_present)
        copytree = mock.Mock(side_effect=shutil.copytree)
        stack = [
            mock.patch.object(cc_ext, "_volume_present", present, create=True),
            mock.patch.object(Path, "mkdir", spy_mkdir),
            mock.patch("shutil.copytree", copytree),
        ]
        for patcher in stack:
            patcher.start()
            self.addCleanup(patcher.stop)
        return present, copytree, mkdirs

    def test_paused_scheduler_makes_no_backup_writes_and_no_target_calls(self):
        present, copytree, mkdirs = self.spies()
        for _ in range(5):
            cc_ext.maybe_backup()
        present.assert_not_called()
        copytree.assert_not_called()
        self.assertEqual(mkdirs, [])
        self.assertFalse(self.bk.exists())
        self.assertEqual(self.alerts("Backup impossible"), [])
        self.assertEqual(cc_ext._last_backup, 0.0)

    def test_paused_with_unusable_default_target_touches_nothing_and_stays_quiet(self):
        del self.cfg["backup_dir"]  # default D:/Backups/Transfert (the failing FAT32 USB volume)
        present, copytree, mkdirs = self.spies(volume_present=False)
        for _ in range(5):
            cc_ext.maybe_backup()
        present.assert_not_called()
        copytree.assert_not_called()
        self.assertEqual(mkdirs, [])
        self.assertEqual(cc_ext.alerts_list(), [], "no repeated (or any) alert for the paused state")
        self.assertEqual(sorted(os.listdir(self.tmp)), ["Transfert"])

    def test_automation_backup_callback_is_skipped_while_paused(self):
        captured = {}
        with mock.patch.object(hq_automation, "bind", lambda **kw: captured.update(kw)), \
                mock.patch.object(hq_events, "bind", lambda *a, **k: None), \
                mock.patch.object(hq_calendar, "bind", lambda *a, **k: None), \
                mock.patch.object(iphone_bridge.hq_companion, "bind", lambda *a, **k: None), \
                mock.patch.object(iphone_bridge, "_HQ_BOUND", iphone_bridge._HQ_BOUND):
            iphone_bridge.bind_hq()
        present, copytree, mkdirs = self.spies()
        result = captured["backup"]()  # what schedules / rules / scenes call
        self.assertTrue(result.get("paused") and result.get("skipped"), result)
        present.assert_not_called()
        copytree.assert_not_called()
        self.assertEqual(mkdirs, [])
        self.assertFalse(self.bk.exists())
        self.assertEqual(self.alerts("Backup impossible"), [])

    def test_manual_backup_still_works_while_paused(self):
        info = cc_ext.run_backup(force=True)  # POST /api/backup
        self.assertTrue(info["ok"])
        self.assertNotIn("paused", info)
        self.assertEqual((Path(info["path"]) / "Inbox" / "a.txt").read_text(encoding="utf-8"), "x")

    def test_manual_backup_while_paused_still_fails_clearly_on_unusable_target(self):
        with mock.patch.object(cc_ext, "_volume_present", return_value=False, create=True):
            with self.assertRaises(RuntimeError) as cm:
                cc_ext.run_backup(force=True)
        self.assertIn("introuvable", str(cm.exception))

    def test_unpaused_behavior_unchanged(self):
        for off in (False, "false", 0, None):
            self.cfg["backup_auto_paused"] = off
            self.assertFalse(cc_ext.backup_auto_paused(), repr(off))
        self.cfg["backup_auto_paused"] = False
        cc_ext.maybe_backup()
        self.assertTrue(any(self.bk.iterdir()), "scheduled backup runs when not paused")
        cc_ext._last_backup = 0.0
        info = cc_ext.run_backup(force=True, automatic=True)
        self.assertTrue(info["ok"])
        self.assertNotIn("paused", info)

    def test_config_flag_is_strict(self):
        for on in (True, 1, "true", "TRUE", " oui ", "yes", "1", "on"):
            self.assertTrue(cc_ext.config_flag(on), repr(on))
        for off in (False, 0, 2, "false", "non", "", None, [], {}):
            self.assertFalse(cc_ext.config_flag(off), repr(off))
        self.assertIs(iphone_bridge.default_config()["backup_auto_paused"], False)

    def test_health_and_status_report_pause(self):
        with mock.patch.object(cc_ext, "smb_share_ok", return_value=False):
            rep = cc_ext.health_report(uptime_sec=1, tailscale_ip=None, version="7.0")
        self.assertTrue(rep["backup"]["auto_paused"])
        self.assertIn("pause", rep["backup"]["note"])
        with mock.patch.object(iphone_bridge, "disk_free", FakeDisks(ROOT=disk(100))), \
                mock.patch.object(iphone_bridge, "lan_ipv4", return_value="192.168.1.10"), \
                mock.patch.object(iphone_bridge, "tailscale_ipv4", return_value=None):
            st = iphone_bridge.bridge_status()
        self.assertIs(st["backup_auto_paused"], True)
        self.cfg["backup_auto_paused"] = False
        self.assertFalse(cc_ext.backup_target_status()["auto_paused"])
        self.assertNotIn("note", cc_ext.backup_target_status())


if __name__ == "__main__":
    unittest.main()
