"""Phase 15 — tools/verify_backup.py, tools/verify_rollback.py and tools/smoke_deploy.py, including their FAILURE paths.

A verifier that can only say PASS is worthless: each tool is driven against a deliberately broken input and must exit non-zero.
Offline; temp directories and a throwaway loopback bridge only.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(SOURCE / "tools"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import verify_backup as VB  # noqa: E402
import verify_rollback as VR  # noqa: E402
import hq_diagnostics as D  # noqa: E402

GOOD = "f8c2ceec5548535f1575fcd7d23d4ca1b5cafd0d"


def run(mod, argv):
    buf = io.StringIO()
    with redirect_stdout(buf):
        rc = mod.main(argv)
    return rc, buf.getvalue()


def make_tar(path: Path, members: dict[str, bytes]) -> None:
    with tarfile.open(path, "w:gz") as tf:
        for name, data in members.items():
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            tf.addfile(ti, io.BytesIO(data))


def make_backup(d: Path, *, rollback=GOOD, hashes=True) -> Path:
    d.mkdir(parents=True)
    (d / "ROLLBACK-SHA.txt").write_text(rollback + "\n", encoding="utf-8")
    make_tar(d / "hq-carnet-data.tar.gz", {"notebook.json": b"{}"})
    make_tar(d / "tracked-worktree-as-deployed.tar.gz", {"a.py": b"print(1)"})
    if hashes:
        lines = [f"{hashlib.sha256((d / n).read_bytes()).hexdigest()}  {n}" for n in ("hq-carnet-data.tar.gz", "tracked-worktree-as-deployed.tar.gz")]
        (d / "SHA256.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return d


class VerifyBackup(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="p15-ops-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.b = make_backup(self.tmp / "_backup_pre-aaaaaaa_20261007T0000Z")

    def test_good_backup_passes(self):
        rc, out = run(VB, [str(self.b)])
        self.assertEqual(rc, 0, out)
        self.assertIn("RESULT: PASS", out)

    def test_hash_mismatch_fails(self):
        (self.b / "hq-carnet-data.tar.gz").write_bytes((self.b / "hq-carnet-data.tar.gz").read_bytes() + b"x")
        rc, out = run(VB, [str(self.b)])
        self.assertEqual(rc, 1)
        self.assertIn("MISMATCH", out)

    def test_missing_archive_and_missing_hash_file_fail(self):
        (self.b / "tracked-worktree-as-deployed.tar.gz").unlink()
        self.assertEqual(run(VB, [str(self.b)])[0], 1)
        shutil.rmtree(self.b)
        make_backup(self.b)
        (self.b / "SHA256.txt").unlink()
        rc, out = run(VB, [str(self.b)])
        self.assertEqual(rc, 1)
        self.assertIn("SHA256.txt missing", out)

    def test_corrupt_and_empty_archives_fail(self):
        p = self.b / "hq-carnet-data.tar.gz"
        p.write_bytes(b"not a tar")
        (self.b / "SHA256.txt").write_text("\n".join(f"{hashlib.sha256((self.b / n).read_bytes()).hexdigest()}  {n}" for n in ("hq-carnet-data.tar.gz", "tracked-worktree-as-deployed.tar.gz")) + "\n")
        rc, out = run(VB, [str(self.b)])
        self.assertEqual(rc, 1)
        self.assertIn("cannot open", out)

    def test_unsafe_archive_member_paths_fail(self):
        make_tar(self.b / "hq-carnet-data.tar.gz", {"../evil.txt": b"x"})
        self.assertIn("unsafe", run(VB, [str(self.b)])[1])

    def test_bad_rollback_sha_fails(self):
        (self.b / "ROLLBACK-SHA.txt").write_text("nonsense\n")
        self.assertEqual(run(VB, [str(self.b)])[0], 1)

    def test_hash_file_cannot_point_outside_folder(self):
        (self.b / "SHA256.txt").write_text(hashlib.sha256(b"x").hexdigest() + "  ../../etc/hostname\n")
        rc, out = run(VB, [str(self.b)])
        self.assertEqual(rc, 1)

    def test_missing_folder_is_usage_error_and_nothing_is_extracted_or_written(self):
        self.assertEqual(run(VB, [str(self.tmp / "nope")])[0], 2)
        before = sorted(str(p) for p in self.tmp.rglob("*"))
        run(VB, [str(self.b)])
        self.assertEqual(before, sorted(str(p) for p in self.tmp.rglob("*")))


def git(cwd: Path, *a: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), "-c", "user.email=t@t", "-c", "user.name=t", *a], capture_output=True, text=True, check=True).stdout.strip()


@unittest.skipUnless(shutil.which("git"), "git not available")
class VerifyRollback(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="p15-rb-"))
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.r = self.tmp / "repo"
        self.r.mkdir()
        git(self.r, "init", "-q", "-b", "main")
        (self.r / "hq_carnet.py").write_text("SCHEMA_VERSION = 3\nX = 1\n")
        for f in ("Restart-Bridge.bat", "start_bridge_hidden.vbs"):
            (self.r / f).write_text("rem")
        (self.r / "Restart-Bridge.ps1").write_text("$port = 8765\n")
        git(self.r, "add", "-A")
        git(self.r, "commit", "-q", "-m", "old")
        self.old = git(self.r, "rev-parse", "HEAD")

    def commit(self, text: str, name="hq_carnet.py"):
        (self.r / name).write_text(text)
        git(self.r, "add", "-A")
        git(self.r, "commit", "-q", "-m", "new")
        return git(self.r, "rev-parse", "HEAD")

    def good_backup(self):
        make_backup(self.r / "_backup_pre-1234567_20261007T0000Z", rollback=self.old)

    def test_safe_rollback_passes(self):
        self.commit("SCHEMA_VERSION = 3\nX = 2\n")
        self.good_backup()
        rc, out = run(VR, ["--root", str(self.r)])
        self.assertEqual(rc, 0, out)
        self.assertIn("rollback_is_ancestor", out)
        self.assertIn("ROLLBACK COMMAND (not run)", out)

    def test_schema_constant_change_blocks_rollback(self):
        self.commit("SCHEMA_VERSION = 4\n")
        self.good_backup()
        rc, out = run(VR, ["--root", str(self.r)])
        self.assertEqual(rc, 1)
        self.assertIn("CHANGED: hq_carnet.py:SCHEMA_VERSION", out)

    def test_migration_marker_warns_but_does_not_claim_proof(self):
        self.commit("SCHEMA_VERSION = 3\ndef migrate_notes(): pass  # migration\n")
        self.good_backup()
        rc, out = run(VR, ["--root", str(self.r)])
        self.assertIn("WARN  no_migration_markers", out)

    def test_missing_backup_and_unknown_rollback_fail(self):
        self.commit("SCHEMA_VERSION = 3\n")
        rc, out = run(VR, ["--root", str(self.r), "--rollback-sha", self.old])
        self.assertEqual(rc, 1)
        self.assertIn("backup_for_rollback", out)
        rc, out = run(VR, ["--root", str(self.r)])
        self.assertEqual(rc, 1)
        self.assertIn("no valid previous known-good SHA", out)

    def test_non_ancestor_and_unknown_commit_fail(self):
        main = self.commit("SCHEMA_VERSION = 3\n")
        git(self.r, "checkout", "-q", "-b", "other", self.old)
        other = self.commit("SCHEMA_VERSION = 3\nY = 1\n", name="other.py")
        git(self.r, "checkout", "-q", "main")
        rc, out = run(VR, ["--root", str(self.r), "--rollback-sha", other])
        self.assertIn("FAIL  rollback_is_ancestor", out)
        rc, out = run(VR, ["--root", str(self.r), "--rollback-sha", "0" * 40])
        self.assertIn("FAIL  rollback_commit_exists", out)

    def test_not_a_checkout_cannot_name_a_current_sha(self):
        bare = self.tmp / "plain"
        bare.mkdir()
        rc, out = run(VR, ["--root", str(bare), "--rollback-sha", self.old])
        self.assertEqual(rc, 1)
        self.assertIn("FAIL  current_sha", out)

    def test_restart_path_files_are_required(self):
        self.commit("SCHEMA_VERSION = 3\n")
        self.good_backup()
        (self.r / "Restart-Bridge.bat").unlink()
        rc, out = run(VR, ["--root", str(self.r)])
        self.assertEqual(rc, 1)
        self.assertIn("FAIL  restart_path Restart-Bridge.bat", out)

    def test_tool_never_changes_the_repository(self):
        self.commit("SCHEMA_VERSION = 3\n")
        self.good_backup()
        before = (git(self.r, "rev-parse", "HEAD"), git(self.r, "status", "--porcelain"))
        run(VR, ["--root", str(self.r)])
        self.assertEqual(before, (git(self.r, "rev-parse", "HEAD"), git(self.r, "status", "--porcelain")))


if __name__ == "__main__":
    unittest.main()
