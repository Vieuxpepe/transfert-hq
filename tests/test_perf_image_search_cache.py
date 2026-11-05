"""Palette search over Forge images: cached by meta.json signature; edits, additions and deletions are seen at once."""
import json
import os
import secrets
import shutil
import tempfile
import threading
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

    def test_overlapping_searches_while_images_change(self):
        # search returns at most 5 hits per group: 3 stable images with a token the churning images never contain
        stable = {_add(self.tmp, "zorblax stable %d" % i) for i in range(3)}
        for i in range(60):
            _add(self.tmp, "dragon filler %d" % i)  # keeps the cache non-trivial
        stop = threading.Event()
        problems = []

        def churn():  # adds, edits and removes other images while searches run
            n = 0
            while not stop.is_set():
                n += 1
                iid = _add(self.tmp, "dragon churn %d" % n)
                meta = B.hq_forge_gallery.gallery_dir(self.tmp) / iid / "meta.json"
                meta.write_text(json.dumps({"id": iid, "created": "x", "settings": {"prompt": "dragon edited %d" % n}}), encoding="utf-8")
                shutil.rmtree(B.hq_forge_gallery.gallery_dir(self.tmp) / iid, ignore_errors=True)

        def searcher():
            for _ in range(25):
                try:
                    got = _ids(B.search_content("zorblax"))
                except Exception as exc:  # noqa: BLE001
                    problems.append(repr(exc))
                    return
                if not stable <= got:  # a failed/partial image read would silently drop stable images
                    problems.append("missing %d stable images" % len(stable - got))
                    return

        mut = threading.Thread(target=churn)
        mut.start()
        workers = [threading.Thread(target=searcher) for _ in range(6)]
        [w.start() for w in workers]
        [w.join() for w in workers]
        stop.set()
        mut.join()
        self.assertEqual(problems, [])


if __name__ == "__main__":
    unittest.main()
