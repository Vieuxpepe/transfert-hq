"""Backup retention (purge) and startup-backup skip.

Offline only: temp dirs, isolated cc_ext / hq_automation state, no Discord, no
live bridge. Guards fail the test on any directory creation, file write or rmtree
outside the test's temp dir (so nothing can ever reach D: or C:\\Backups).
"""

from __future__ import annotations

import builtins
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest import mock

import cc_ext
import hq_automation
import hq_events
import iphone_bridge

DAY = 86400
STATE = (
    "_lock", "_activity", "_alerts", "ROOT", "human_size", "notify_discord", "disk_free", "get_config",
    "_disk_alerted", "_disk_missing_alerted", "_backup_alerted", "_last_backup", "_last_purge", "_backup_seed",
)
REAL_MKDIR = Path.mkdir
REAL_OS_MKDIR = os.mkdir
REAL_OPEN = builtins.open
REAL_RMTREE = shutil.rmtree


def _inside(root: str, path) -> bool:
    try:
        target = os.path.abspath(os.fspath(path))
        return os.path.commonpath([root, target]) == root
    except (ValueError, TypeError):  # other drive on Windows, fd, ...
        return False


def write_guards(test_root: Path):
    """Patches that refuse mkdir / write-open / rmtree outside test_root."""
    root = os.path.abspath(str(test_root))

    def path_mkdir(self, *a, **k):
        if not _inside(root, self):
            raise AssertionError(f"mkdir outside temp: {self}")
        return REAL_MKDIR(self, *a, **k)

    def os_mkdir(path, *a, **k):
        if "dir_fd" not in k and not _inside(root, path):
            raise AssertionError(f"os.mkdir outside temp: {path}")
        return REAL_OS_MKDIR(path, *a, **k)

    def guarded_open(file, mode="r", *a, **k):
        if isinstance(file, (str, bytes, os.PathLike)) and any(c in mode for c in "wax+") and not _inside(root, file):
            raise AssertionError(f"write outside temp: {file}")
        return REAL_OPEN(file, mode, *a, **k)

    def rmtree(path, *a, **k):
        if not _inside(root, path) or os.path.abspath(os.fspath(path)) == root:
            raise AssertionError(f"rmtree outside temp: {path}")
        return REAL_RMTREE(path, *a, **k)

    return [
        mock.patch.object(Path, "mkdir", path_mkdir),
        mock.patch("os.mkdir", os_mkdir),
        mock.patch("builtins.open", guarded_open),
        mock.patch("io.open", guarded_open),
        mock.patch("shutil.rmtree", rmtree),
    ]


def stamp(days_ago: float, *, base: datetime | None = None, seconds: int = 0) -> str:
    moment = (base or datetime.now()) - timedelta(days=days_ago) + timedelta(seconds=seconds)
    return moment.strftime("%Y%m%d_%H%M%S")


def make_link(target: Path, link: Path) -> str:
    """'symlink' or 'junction' (Windows) — SkipTest when neither can be created."""
    try:
        os.symlink(target, link, target_is_directory=True)
        return "symlink"
    except (OSError, NotImplementedError, AttributeError):
        pass
    if sys.platform == "win32":
        try:
            import _winapi

            _winapi.CreateJunction(str(target), str(link))
            return "junction"
        except (ImportError, OSError, AttributeError):
            pass
    raise unittest.SkipTest("cannot create symlinks or junctions here")


def make_junction(target: Path, link: Path) -> None:
    if sys.platform != "win32":
        raise unittest.SkipTest("junctions are Windows-only")
    try:
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
    except (ImportError, OSError, AttributeError) as e:
        raise unittest.SkipTest(f"cannot create a junction: {e}")


class RetentionBase(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-retention-")).resolve()
        self.addCleanup(REAL_RMTREE, self.tmp, ignore_errors=True)
        saved = {name: getattr(cc_ext, name, None) for name in STATE}
        saved_cb, saved_ready = dict(hq_automation._cb), hq_automation._ready

        def restore():
            for name, value in saved.items():
                setattr(cc_ext, name, value)
            hq_automation._cb.clear()
            hq_automation._cb.update(saved_cb)
            hq_automation._ready = saved_ready

        self.addCleanup(restore)
        self.root = self.tmp / "Transfert"
        (self.root / "Inbox").mkdir(parents=True)
        (self.root / "Inbox" / "a.txt").write_text("x", encoding="utf-8")
        self.bk = self.tmp / "bk"
        self.bk.mkdir()
        self.cfg: dict = {"backup_dir": str(self.bk), "backup_every_hours": 24, "backup_keep_days": 14, "backup_keep_min": 3}
        self.journal: list[tuple[str, str]] = []
        self.events: list[tuple[str, str, dict]] = []
        cc_ext._lock = threading.Lock()
        cc_ext._activity = []
        cc_ext._alerts = []
        cc_ext._backup_alerted = False
        cc_ext._last_backup = 0.0
        cc_ext._last_purge = {}
        cc_ext._backup_seed = {}
        cc_ext.ROOT = self.root
        cc_ext.human_size = lambda n: f"{n} o"
        cc_ext.notify_discord = None
        cc_ext.get_config = lambda: self.cfg
        hq_automation.bind(
            root=self.root,
            get_config=lambda: self.cfg,
            journal=lambda kind, message, **extra: self.journal.append((kind, message)),
        )
        cwd = os.getcwd()
        os.chdir(self.tmp)
        self.addCleanup(os.chdir, cwd)
        record = lambda kind, message, **kw: self.events.append((kind, message, kw.get("meta") or {}))
        for patcher in [
            mock.patch.object(hq_events, "enabled", return_value=True),
            mock.patch.object(hq_events, "record", side_effect=record),
            *write_guards(self.tmp),
        ]:
            patcher.start()
            self.addCleanup(patcher.stop)

    # -- helpers --
    def make_backup(self, name: str, *, parent: Path | None = None, marker: str | None = "auto",
                    index: bool = True, at: float | None = None, content: bool = True) -> Path:
        parent = parent or self.bk
        folder = parent / name
        (folder / "Inbox").mkdir(parents=True)
        if content:
            (folder / "Inbox" / "old.txt").write_text("old", encoding="utf-8")
        if marker == "auto":
            marker = f"Transfert backup {name}\n"
        if marker is not None:
            (folder / "README.txt").write_text(marker, encoding="utf-8")
        if index:
            ts = datetime.strptime(name, "%Y%m%d_%H%M%S").timestamp() if at is None else at
            hq_automation.note_backup({"id": name, "path": str(folder), "folders": 1, "at": ts})
        return folder

    def index(self) -> list[dict]:
        path = self.root / hq_automation.BACKUP_INDEX_NAME
        if not path.is_file():
            return []
        return json.loads(path.read_text(encoding="utf-8")).get("backups") or []

    def names(self) -> list[str]:
        return sorted(p.name for p in self.bk.iterdir())


class RetentionConfigTests(RetentionBase):
    def test_guards_block_writes_outside_temp(self):
        outside = self.tmp.parent / (self.tmp.name + "-guard-probe")
        with self.assertRaises(AssertionError):
            outside.mkdir()
        with self.assertRaises(AssertionError):
            os.mkdir(outside)
        with self.assertRaises(AssertionError):
            open(outside, "w")
        with self.assertRaises(AssertionError):
            shutil.rmtree(self.tmp)
        self.assertFalse(outside.exists())

    def test_keep_days_is_parsed_strictly(self):
        p = cc_ext.parse_backup_keep_days
        self.assertEqual(p(None), 14)
        self.assertEqual(p(7), 7)
        self.assertEqual(p(7.0), 7)
        self.assertEqual(p("30"), 30)
        self.assertEqual(p(" 5 "), 5)
        self.assertEqual(p(0), 0)
        self.assertEqual(p(-3), 0)
        self.assertEqual(p("-1"), 0)
        for bad in (True, False, "abc", "7j", 7.5, float("nan"), float("inf"), [], {}, ""):
            self.assertEqual(p(bad), 14, bad)
        self.assertEqual(p(10**9), cc_ext.BACKUP_KEEP_DAYS_MAX)

    def test_keep_min_default_3_minimum_1(self):
        p = cc_ext.parse_backup_keep_min
        self.assertEqual(p(None), 3)
        self.assertEqual(p(5), 5)
        self.assertEqual(p("2"), 2)
        self.assertEqual(p(0), 1)
        self.assertEqual(p(-4), 1)
        for bad in (True, "x", 2.5, None):
            self.assertEqual(p(bad), 3, bad)

    def test_defaults_and_load_config_normalization(self):
        defaults = iphone_bridge.default_config()
        self.assertEqual((defaults["backup_keep_days"], defaults["backup_keep_min"]), (14, 3))
        path = self.tmp / "bridge_config.json"
        cases = [({}, 14, 3), ({"backup_keep_days": "30", "backup_keep_min": "5"}, 30, 5),
                 ({"backup_keep_days": "oops", "backup_keep_min": 0}, 14, 1), ({"backup_keep_days": -2}, 0, 3)]
        with mock.patch.object(iphone_bridge, "CONFIG_PATH", path):
            for data, days, keep in cases:
                path.write_text(json.dumps(data), encoding="utf-8")
                cfg = iphone_bridge.load_config(write=False)
                self.assertEqual((cfg["backup_keep_days"], cfg["backup_keep_min"]), (days, keep), data)

    def test_health_reports_retention(self):
        status = cc_ext.backup_target_status()["retention"]
        self.assertEqual((status["keep_days"], status["keep_min"], status["enabled"]), (14, 3, True))
        self.assertIsNone(status["last_purge_count"])
        self.assertIsNone(status["last_purge_at"])
        self.make_backup(stamp(40))
        before = time.time()
        cc_ext.run_backup(force=True)
        status = cc_ext.backup_target_status()["retention"]
        self.assertEqual(status["last_purge_count"], 0)  # only 2 backups: both inside keep_min
        self.assertGreaterEqual(status["last_purge_at"], before)
        self.assertEqual(status["last_purge_errors"], 0)


class PurgeTests(RetentionBase):
    def test_purge_deletes_old_marked_correctly_named_folders(self):
        old = [self.make_backup(stamp(d)) for d in (20, 30, 40, 50)]
        recent = self.make_backup(stamp(2))
        info = cc_ext.run_backup(force=True)
        # kept: the new backup, the 2-day one, and (keep_min=3) the newest old one (20 days)
        self.assertEqual(self.names(), sorted([info["id"], recent.name, old[0].name]))
        self.assertEqual(sorted(d["id"] for d in info["purge"]["deleted"]), sorted(p.name for p in old[1:]))
        self.assertTrue(info["purge"]["ok"])
        for p in old[1:]:
            self.assertFalse(os.path.lexists(p))

    def test_keeps_newest_three_even_when_all_are_old(self):
        old = [self.make_backup(stamp(d)) for d in (100, 200, 300, 400, 500)]
        result = cc_ext.purge_old_backups()
        self.assertEqual(self.names(), sorted(p.name for p in old[:3]))
        self.assertEqual(len(result["deleted"]), 2)
        self.assertEqual(result["kept"], 3)

    def test_keep_min_config_is_honored(self):
        old = [self.make_backup(stamp(d)) for d in (100, 200, 300)]
        self.cfg["backup_keep_min"] = 1
        cc_ext.purge_old_backups()
        self.assertEqual(self.names(), [old[0].name])
        self.cfg["backup_keep_min"] = 0  # minimum 1: never deletes the last backup
        cc_ext.purge_old_backups()
        self.assertEqual(self.names(), [old[0].name])

    def test_recent_folders_are_kept(self):
        keep = [self.make_backup(stamp(d)) for d in (1, 5, 10, 13)]
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        self.assertEqual(self.names(), sorted(p.name for p in keep))

    def test_ignores_unmarked_wrongly_named_folders_and_files(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        untouched = []
        untouched.append(self.make_backup(stamp(60), marker=None, index=False))                    # no marker
        n = stamp(61)
        untouched.append(self.make_backup(n, marker=f"Transfert backup {stamp(62)}\n", index=False))  # marker for another id
        untouched.append(self.make_backup(stamp(63), marker="Autre chose\n", index=False))
        for bad in ("20200101_00000", "backup_20200101_000000", "20200101-000000", "20201399_000000", "2020010100_0000"):
            f = self.bk / bad
            (f / "Inbox").mkdir(parents=True)
            (f / "README.txt").write_text(f"Transfert backup {bad}\n", encoding="utf-8")
            untouched.append(f)
        f = self.bk / stamp(64)
        f.write_text(f"Transfert backup {f.name}\n", encoding="utf-8")  # a FILE with a backup name
        untouched.append(f)
        m = self.make_backup(stamp(65), marker=None, index=False)
        (m / "README.txt").mkdir()  # marker path is a directory
        untouched.append(m)
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        for p in untouched:
            self.assertTrue(os.path.lexists(p), p)
        reasons = {s["id"]: s["reason"] for s in result["skipped"]}
        self.assertIn("sans marqueur", reasons[untouched[0].name])

    def test_ignores_linked_backup_folder_and_keeps_its_target(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        outside = self.tmp / "outside"
        target = self.make_backup(stamp(90), parent=outside, index=False)
        link = self.bk / stamp(91)
        kind = make_link(target, link)
        (outside / stamp(91)).mkdir()  # not relevant, keeps names distinct
        hq_automation.note_backup({"id": link.name, "path": str(link), "folders": 1,
                                   "at": datetime.strptime(link.name, "%Y%m%d_%H%M%S").timestamp()})
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [], kind)
        self.assertTrue(os.path.lexists(link))
        self.assertTrue((target / "Inbox" / "old.txt").is_file())
        self.assertIn({"id": link.name, "reason": "lien/jonction"}, result["skipped"])

    def test_ignores_junction_windows(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        target = self.make_backup(stamp(90), parent=self.tmp / "outside", index=False)
        link = self.bk / stamp(92)
        make_junction(target, link)
        st = os.lstat(link)
        self.assertTrue(st.st_file_attributes & 0x400, "junction must be a reparse point")
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        self.assertTrue(os.path.lexists(link))
        self.assertTrue((target / "Inbox" / "old.txt").is_file())

    def test_rejects_folder_with_a_link_inside_and_never_follows_it(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        precious = self.tmp / "precious"
        precious.mkdir()
        (precious / "keep.txt").write_text("keep", encoding="utf-8")
        old = self.make_backup(stamp(80))
        make_link(precious, old / "Inbox" / "link")
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        self.assertEqual(result["errors"][0]["id"], old.name)
        self.assertIn("lien", result["errors"][0]["error"])
        self.assertTrue((precious / "keep.txt").is_file())
        self.assertTrue(old.is_dir())
        self.assertTrue(any("Purge impossible" in a["message"] for a in cc_ext.activity_list()))

    def test_never_touches_paths_outside_backup_dir(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        other = self.tmp / "other_dir"
        foreign = self.make_backup(stamp(70), parent=other)  # indexed, old, marked — but another dir
        sibling = self.make_backup(stamp(71), parent=self.tmp)  # next to backup_dir
        cc_ext.purge_old_backups()
        self.assertTrue((foreign / "Inbox" / "old.txt").is_file())
        self.assertTrue((sibling / "Inbox" / "old.txt").is_file())
        self.assertIn(str(foreign), [b["path"] for b in self.index()])

    def test_backup_dir_that_is_a_link_is_refused(self):
        real = self.tmp / "real_bk"
        real.mkdir()
        for d in (100, 200, 300, 400):
            self.make_backup(stamp(d), parent=real, index=False)
        linked = self.tmp / "linked_bk"
        make_link(real, linked)
        self.cfg["backup_dir"] = str(linked)
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        self.assertIn("lien", result["reason"])
        self.assertEqual(len(list(real.iterdir())), 4)

    def test_index_at_must_agree_with_folder_name(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        renamed = self.make_backup(stamp(60), at=time.time() - 2 * DAY)  # catalog says 2 days old
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        self.assertTrue(renamed.is_dir())
        self.assertIn({"id": renamed.name, "reason": "horodatage incohérent avec l'index"}, result["skipped"])

    def test_read_only_files_inside_are_removed(self):
        for d in (1, 2, 3):
            self.make_backup(stamp(d))
        old = self.make_backup(stamp(40))
        ro = old / "Inbox" / "old.txt"
        os.chmod(ro, stat.S_IREAD)
        result = cc_ext.purge_old_backups()
        self.assertEqual([d["id"] for d in result["deleted"]], [old.name])
        self.assertFalse(os.path.lexists(old))

    def test_keep_days_zero_or_negative_disables_purging(self):
        old = [self.make_backup(stamp(d)) for d in (100, 200, 300, 400, 500)]
        for value in (0, -5, "0"):
            self.cfg["backup_keep_days"] = value
            info = cc_ext.run_backup(force=True)
            self.assertTrue(info["purge"]["disabled"])
            self.assertEqual(info["purge"]["deleted"], [])
            for p in old:
                self.assertTrue(p.is_dir())
            self.assertFalse(cc_ext.backup_target_status()["retention"]["enabled"])
            time.sleep(1.05)  # distinct backup stamp per iteration

    def test_no_purge_after_failed_backup(self):
        old = [self.make_backup(stamp(d)) for d in (100, 200, 300, 400, 500)]
        purge = mock.Mock(side_effect=cc_ext.purge_old_backups)
        with mock.patch.object(cc_ext, "purge_old_backups", purge), \
                mock.patch("shutil.copytree", side_effect=OSError("disque plein")):
            with self.assertRaises(RuntimeError):
                cc_ext.run_backup(force=True)
            cc_ext.maybe_backup()  # scheduled failure: alert, no purge
        purge.assert_not_called()
        for p in old:
            self.assertTrue(p.is_dir())
        self.cfg["backup_dir"] = str(self.tmp / "missing" / "bk")
        with mock.patch.object(cc_ext, "purge_old_backups", purge), \
                mock.patch.object(cc_ext, "_volume_present", return_value=False):
            with self.assertRaises(RuntimeError):
                cc_ext.run_backup(force=True)
        purge.assert_not_called()

    def test_no_purge_after_skipped_or_paused_backup(self):
        old = [self.make_backup(stamp(d)) for d in (100, 200, 300, 400, 500)]
        purge = mock.Mock(side_effect=cc_ext.purge_old_backups)
        with mock.patch.object(cc_ext, "purge_old_backups", purge):
            cc_ext._last_backup = time.time() - 60
            self.assertTrue(cc_ext.run_backup()["skipped"])  # within backup_every_hours
            cc_ext.maybe_backup()
            self.cfg["backup_auto_paused"] = True
            cc_ext._last_backup = 0.0
            self.assertTrue(cc_ext.run_backup(automatic=True)["paused"])
            cc_ext.maybe_backup()
        purge.assert_not_called()
        self.assertEqual(self.names(), sorted(p.name for p in old))

    def test_index_activity_and_events_are_updated(self):
        old = [self.make_backup(stamp(d)) for d in (30, 40, 50, 60)]
        info = cc_ext.run_backup(force=True)
        deleted = {d["id"] for d in info["purge"]["deleted"]}
        self.assertEqual(deleted, {old[2].name, old[3].name})
        paths = [b["path"] for b in self.index()]
        self.assertIn(info["path"], paths)
        for p in old[2:]:
            self.assertNotIn(str(p), paths)
        for p in old[:2]:
            self.assertIn(str(p), paths)
        self.assertEqual(info["purge"]["index_removed"], 2)
        messages = [a["message"] for a in cc_ext.activity_list() if a["kind"] == "backup"]
        for p in old[2:]:
            self.assertTrue(any("Backup purgé" in m and p.name in m for m in messages), p.name)
        purge_events = [e for e in self.events if e[0] == "backup" and "Backup purgé" in e[1]]
        self.assertEqual(len(purge_events), 2)
        self.assertTrue(all(e[2].get("purge") is True for e in purge_events))
        self.assertTrue(any("Catalogue" in m and "retiré" in m for _k, m in self.journal))

    def test_delete_failure_is_logged_and_does_not_break_the_backup(self):
        old = [self.make_backup(stamp(d)) for d in (30, 40, 50, 60)]
        real = cc_ext._remove_backup_folder

        def flaky(path):
            if path.endswith(old[2].name):
                return "accès refusé (test)"
            return real(path)

        with mock.patch.object(cc_ext, "_remove_backup_folder", side_effect=flaky):
            info = cc_ext.run_backup(force=True)
        self.assertTrue(info["ok"])
        self.assertFalse(info["purge"]["ok"])
        self.assertEqual([e["id"] for e in info["purge"]["errors"]], [old[2].name])
        self.assertEqual([d["id"] for d in info["purge"]["deleted"]], [old[3].name])
        self.assertTrue(old[2].is_dir())
        self.assertIn(str(old[2]), [b["path"] for b in self.index()])
        self.assertTrue(any("Purge impossible" in a["message"] and old[2].name in a["message"] for a in cc_ext.activity_list()))
        self.assertEqual(cc_ext.backup_target_status()["retention"]["last_purge_errors"], 1)

    def test_purge_exception_never_fails_the_backup(self):
        with mock.patch.object(cc_ext, "purge_old_backups", side_effect=RuntimeError("boom")):
            info = cc_ext.run_backup(force=True)
        self.assertTrue(info["ok"])
        self.assertFalse(info["purge"]["ok"])
        self.assertTrue((self.bk / info["id"] / "Inbox" / "a.txt").is_file())

    def test_malformed_index_refuses_purge(self):
        old = [self.make_backup(stamp(d), index=False) for d in (100, 200, 300, 400)]
        (self.root / hq_automation.BACKUP_INDEX_NAME).write_text("{ broken", encoding="utf-8")
        result = cc_ext.purge_old_backups()
        self.assertEqual(result["deleted"], [])
        self.assertIn("illisible", result["reason"])
        self.assertEqual(len(self.names()), len(old))


class StartupSeedTests(RetentionBase):
    def backups_made(self) -> int:
        return len(list(self.bk.iterdir()))

    def test_restart_within_interval_makes_no_backup(self):
        self.make_backup(stamp(0, seconds=-3600))  # 1 h ago, this backup_dir
        info = cc_ext.seed_last_backup_from_index()
        self.assertTrue(info["seeded"])
        cc_ext.maybe_backup()
        self.assertEqual(self.backups_made(), 1)
        self.assertTrue(cc_ext.backup_target_status()["startup_seed"]["seeded"])

    def test_restart_after_interval_backs_up(self):
        self.make_backup(stamp(0, seconds=-25 * 3600))
        self.assertTrue(cc_ext.seed_last_backup_from_index()["seeded"])
        cc_ext.maybe_backup()
        self.assertEqual(self.backups_made(), 2)

    def test_seed_uses_newest_entry_of_this_dir(self):
        self.make_backup(stamp(3))
        newest = self.make_backup(stamp(0, seconds=-600))
        info = cc_ext.seed_last_backup_from_index()
        self.assertEqual(info["id"], newest.name)

    def test_missing_index_backs_up_on_start(self):
        self.assertFalse((self.root / hq_automation.BACKUP_INDEX_NAME).exists())
        info = cc_ext.seed_last_backup_from_index()
        self.assertFalse(info["seeded"])
        cc_ext.maybe_backup()
        self.assertEqual(self.backups_made(), 1)

    def test_corrupt_index_backs_up_on_start(self):
        (self.root / hq_automation.BACKUP_INDEX_NAME).write_text("{ broken", encoding="utf-8")
        info = cc_ext.seed_last_backup_from_index()
        self.assertFalse(info["seeded"])
        self.assertIn("illisible", info["reason"])
        cc_ext.maybe_backup()
        self.assertEqual(self.backups_made(), 1)

    def test_entry_for_another_backup_dir_backs_up_on_start(self):
        self.make_backup(stamp(0, seconds=-600), parent=self.tmp / "old_target")  # e.g. D:
        info = cc_ext.seed_last_backup_from_index()
        self.assertFalse(info["seeded"])
        cc_ext.maybe_backup()
        self.assertEqual(self.backups_made(), 1)

    def test_future_entry_backs_up_on_start(self):
        self.make_backup(stamp(-2))  # stamped two days in the future
        info = cc_ext.seed_last_backup_from_index()
        self.assertFalse(info["seeded"])
        self.assertIn("futur", info["reason"])
        cc_ext.maybe_backup()
        self.assertEqual(self.backups_made(), 2)

    def test_manual_backup_stays_forced(self):
        self.make_backup(stamp(0, seconds=-60))
        cc_ext.seed_last_backup_from_index()
        info = cc_ext.run_backup(force=True)
        self.assertFalse(info.get("skipped"))
        self.assertEqual(self.backups_made(), 2)

    def test_paused_flag_still_wins(self):
        self.cfg["backup_auto_paused"] = True
        info = cc_ext.seed_last_backup_from_index()  # no entry -> would back up if not paused
        self.assertFalse(info["seeded"])
        probe = mock.Mock(return_value=True)
        with mock.patch.object(cc_ext, "_volume_present", probe):
            cc_ext.maybe_backup()
            self.assertTrue(cc_ext.run_backup(automatic=True)["paused"])
        probe.assert_not_called()
        self.assertEqual(self.backups_made(), 0)

    def test_seed_never_reads_backup_dir(self):
        self.make_backup(stamp(0, seconds=-600))
        with mock.patch("os.scandir", side_effect=AssertionError("backup_dir scanned")), \
                mock.patch.object(cc_ext, "_volume_present", side_effect=AssertionError("target probed")):
            self.assertTrue(cc_ext.seed_last_backup_from_index()["seeded"])

    def test_bridge_startup_seeds_before_the_monitor_starts(self):
        import inspect

        src = inspect.getsource(iphone_bridge.main)
        self.assertIn("cc_ext.seed_last_backup_from_index()", src)
        self.assertLess(src.index("bind_hq()"), src.index("seed_last_backup_from_index"))
        self.assertLess(src.index("seed_last_backup_from_index"), src.index("cc_ext.start_monitor("))


if __name__ == "__main__":
    unittest.main()
