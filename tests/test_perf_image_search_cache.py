"""Palette search over Forge images: cached by meta.json signature; edits, additions and deletions are seen at once."""
import json
import os
import secrets
import shutil
import tempfile
import time
import unittest
from pathlib import Path

import iphone_bridge as B


def _add(root, prompt):
    iid = "img-" + secrets.token_hex(12)
    d = B.hq_forge_gallery.gallery_dir(root) / iid
    d.mkdir(parents=True)
    (d / "meta.json").write_text(json.dumps({"id": iid, "created": "2026-01-01T00:00:00Z", "settings": {"prompt": prompt}}), encoding="utf-8")
    return iid


def _ids(hits):
    return {h["id"] for h in hits if h.get("kind") == "prompt"}


class ImageSearchCacheTests(unittest.TestCase):
    def setUp(self):
        self._root = B.ROOT
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-imgsearch-"))
        (self.tmp / "Inbox").mkdir()
        B.ROOT = self.tmp
        B._IMG_SEARCH_CACHE.clear()

    def tearDown(self):
        B.ROOT = self._root
        B._IMG_SEARCH_CACHE.clear()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_add_edit_delete_are_visible_immediately(self):
        a = _add(self.tmp, "un dragon sur la montagne")
        self.assertEqual(_ids(B.search_content("dragon")), {a})
        self.assertEqual(_ids(B.search_content("dragon")), {a})  # warm path, same answer
        b = _add(self.tmp, "dragon et château")
        self.assertEqual(_ids(B.search_content("dragon")), {a, b})  # new folder
        meta = B.hq_forge_gallery.gallery_dir(self.tmp) / a / "meta.json"
        time.sleep(0.02)
        meta.write_text(json.dumps({"id": a, "created": "x", "settings": {"prompt": "une licorne rose"}}), encoding="utf-8")
        self.assertEqual(_ids(B.search_content("dragon")), {b})  # edited prompt no longer matches
        self.assertEqual(_ids(B.search_content("licorne")), {a})
        shutil.rmtree(B.hq_forge_gallery.gallery_dir(self.tmp) / b)
        self.assertEqual(_ids(B.search_content("dragon")), set())  # deleted image drops out
        self.assertNotIn(b, next(iter(B._IMG_SEARCH_CACHE.values()), {}))

    def test_accents_and_invalid_entries(self):
        a = _add(self.tmp, "Forêt enchantée")
        bad = B.hq_forge_gallery.gallery_dir(self.tmp) / ("img-" + "0" * 24)
        bad.mkdir()
        (bad / "meta.json").write_text("{not json", encoding="utf-8")
        (B.hq_forge_gallery.gallery_dir(self.tmp) / "notanimage").mkdir()
        self.assertEqual(_ids(B.search_content("foret")), {a})

    def test_symlinked_meta_is_ignored(self):
        a = _add(self.tmp, "secret dragon")
        outside = self.tmp / "outside.json"
        outside.write_text(json.dumps({"id": "img-" + "1" * 24, "settings": {"prompt": "dragon"}}), encoding="utf-8")
        d = B.hq_forge_gallery.gallery_dir(self.tmp) / ("img-" + "1" * 24)
        d.mkdir()
        try:
            os.symlink(outside, d / "meta.json")
        except (OSError, NotImplementedError):
            self.skipTest("symlinks not permitted here")
        self.assertEqual(_ids(B.search_content("dragon")), {a})


if __name__ == "__main__":
    unittest.main()
