"""tests/hq_temp_janitor.py: only stale hq-* test copies of HQ go, and links inside them are never followed."""
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_temp_janitor as janitor  # noqa: E402


class JanitorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name) / "temp"
        self.base.mkdir()
        self.outside = Path(self.tmp.name) / "real-files"
        self.outside.mkdir()
        (self.outside / "keep.txt").write_text("precious")

    def root(self, name, *, hours_old, assets=True, marker=False):
        root = self.base / name
        root.mkdir()
        if assets:
            (root / "assets" / "companion").mkdir(parents=True)
            (root / "assets" / "hq.js").write_text("// HQ")
            (root / "assets" / "companion" / "big.bin").write_bytes(b"x" * 1024)
        if marker:
            janitor.mark(root)
        stamp = time.time() - hours_old * 3600
        for path in [root, *root.iterdir()]:
            os.utime(path, (stamp, stamp))
        return root

    def test_only_stale_hq_test_copies_are_removed_whatever_their_name(self):
        old = self.root("hq-calview-old", hours_old=5)
        marked = self.root("hq-carnet-api-x", hours_old=5, assets=False, marker=True)
        other_prefix = self.root("p15-http-abc", hours_old=5, assets=False)
        (other_prefix / "root" / "assets").mkdir(parents=True)
        (other_prefix / "root" / "assets" / "hq.js").write_text("// HQ")
        stamp = time.time() - 5 * 3600
        os.utime(other_prefix, (stamp, stamp))
        fresh = self.root("hq-calview-fresh", hours_old=0.5)
        plain = self.root("hq-something-else", hours_old=5, assets=False)
        foreign = self.root("other-tool-cache", hours_old=5, assets=False)
        (foreign / "assets").mkdir()  # some other program's « assets » folder: no hq.js, not ours
        os.utime(foreign, (stamp, stamp))
        expected = sorted([marked.name, old.name, other_prefix.name])
        self.assertEqual(sorted(p.name for p in janitor.stale_roots(base=self.base)), expected)
        self.assertEqual(janitor.prune(base=self.base), 3)
        for gone in (old, marked, other_prefix):
            self.assertFalse(gone.exists(), gone.name)
        for kept in (fresh, plain, foreign):
            self.assertTrue(kept.exists(), kept.name)

    @unittest.skipUnless(os.name == "nt", "directory junctions are a Windows feature")
    def test_junction_inside_a_stale_root_is_removed_not_followed(self):
        import _winapi

        old = self.root("hq-forge-qw-old", hours_old=5)
        _winapi.CreateJunction(str(self.outside), str(old / "assets" / "linked"))
        stamp = time.time() - 5 * 3600
        os.utime(old, (stamp, stamp))
        os.utime(old / "assets", (stamp, stamp))
        self.assertEqual(janitor.prune(base=self.base), 1)
        self.assertFalse(old.exists())
        self.assertEqual((self.outside / "keep.txt").read_text(), "precious")  # the junction's target is untouched

    def test_opt_out_and_once_per_process(self):
        os.environ["HQ_KEEP_TEST_ROOTS"] = "1"
        self.addCleanup(os.environ.pop, "HQ_KEEP_TEST_ROOTS", None)
        janitor._started = False
        janitor.prune_in_background()
        self.assertFalse(janitor._started)


if __name__ == "__main__":
    unittest.main()
