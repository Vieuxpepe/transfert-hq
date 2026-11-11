"""Startup must not move Git-tracked project documents into Inbox."""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import iphone_bridge as bridge


class StartupMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-migrate-"))
        self.saved = (bridge.ROOT, json.loads(json.dumps(bridge.CONFIG)))
        bridge.ROOT = self.tmp
        bridge.CONFIG["default_folder"] = "Inbox"
        bridge.CONFIG["folders"] = ["Inbox"]

    def tearDown(self) -> None:
        bridge.ROOT = self.saved[0]
        bridge.CONFIG.clear()
        bridge.CONFIG.update(self.saved[1])
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _git(self, *args: str) -> None:
        subprocess.run(["git", "-C", str(self.tmp), *args], check=True, capture_output=True)

    def test_tracked_markdown_and_mini_quests_stay(self) -> None:
        self._git("init")
        (self.tmp / "MINI_QUESTS.md").write_text("quests\n", encoding="utf-8")
        (self.tmp / "NOTES.md").write_text("notes\n", encoding="utf-8")
        (self.tmp / "photo.jpg").write_bytes(b"jpg")
        self._git("add", "MINI_QUESTS.md", "NOTES.md")
        bridge.ensure_folders_and_migrate()
        self.assertTrue((self.tmp / "MINI_QUESTS.md").is_file())
        self.assertTrue((self.tmp / "NOTES.md").is_file())
        self.assertFalse((self.tmp / "Inbox" / "MINI_QUESTS.md").exists())
        self.assertFalse((self.tmp / "Inbox" / "NOTES.md").exists())
        self.assertTrue((self.tmp / "Inbox" / "photo.jpg").is_file())
        self.assertFalse((self.tmp / "photo.jpg").exists())

    def test_destination_collision_preserves_both(self) -> None:
        self._git("init")
        inbox = self.tmp / "Inbox"
        inbox.mkdir()
        (inbox / "photo.jpg").write_bytes(b"already")
        (self.tmp / "photo.jpg").write_bytes(b"incoming")
        bridge.ensure_folders_and_migrate()
        self.assertEqual((self.tmp / "photo.jpg").read_bytes(), b"incoming")
        self.assertEqual((inbox / "photo.jpg").read_bytes(), b"already")
        self.assertFalse((inbox / "photo-migrated.jpg").exists())

    def test_missing_git_metadata_does_not_migrate(self) -> None:
        (self.tmp / "MINI_QUESTS.md").write_text("stay\n", encoding="utf-8")
        (self.tmp / "photo.jpg").write_bytes(b"jpg")
        bridge.ensure_folders_and_migrate()
        self.assertTrue((self.tmp / "MINI_QUESTS.md").is_file())
        self.assertTrue((self.tmp / "photo.jpg").is_file())
        self.assertFalse((self.tmp / "Inbox" / "MINI_QUESTS.md").exists())
        self.assertFalse((self.tmp / "Inbox" / "photo.jpg").exists())

    def test_unreadable_git_metadata_does_not_migrate(self) -> None:
        (self.tmp / ".git").write_text("gitdir: nowhere\n", encoding="utf-8")
        (self.tmp / "MINI_QUESTS.md").write_text("stay\n", encoding="utf-8")
        bridge.ensure_folders_and_migrate()
        self.assertTrue((self.tmp / "MINI_QUESTS.md").is_file())
        self.assertFalse((self.tmp / "Inbox" / "MINI_QUESTS.md").exists())

    def test_repeated_startup_is_idempotent(self) -> None:
        self._git("init")
        (self.tmp / "MINI_QUESTS.md").write_text("quests\n", encoding="utf-8")
        (self.tmp / "photo.jpg").write_bytes(b"jpg")
        self._git("add", "MINI_QUESTS.md")
        bridge.ensure_folders_and_migrate()
        bridge.ensure_folders_and_migrate()
        self.assertEqual((self.tmp / "MINI_QUESTS.md").read_text(encoding="utf-8"), "quests\n")
        self.assertEqual((self.tmp / "Inbox" / "photo.jpg").read_bytes(), b"jpg")
        self.assertFalse((self.tmp / "photo.jpg").exists())
        self.assertFalse((self.tmp / "Inbox" / "photo-migrated.jpg").exists())

    def test_migration_stays_inside_root(self) -> None:
        self._git("init")
        outside = self.tmp.parent / (self.tmp.name + "-outside")
        (self.tmp / "photo.jpg").write_bytes(b"jpg")
        bridge.CONFIG["default_folder"] = ".." + "\\" + outside.name
        try:
            bridge.ensure_folders_and_migrate()
            self.assertTrue((self.tmp / "photo.jpg").is_file())
            self.assertFalse(outside.exists())
        finally:
            if outside.exists():
                shutil.rmtree(outside, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
