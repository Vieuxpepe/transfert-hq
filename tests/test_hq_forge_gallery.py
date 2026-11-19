"""Gallery confinement, validation, quota, and admin delete."""

from __future__ import annotations

import io
import json
import sys
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_gallery as G  # noqa: E402


def _png(width: int = 256, height: int = 256) -> bytes:
    image = Image.new("RGB", (width, height), (12, 24, 36))
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def _settings() -> dict:
    return {
        "prompt": "a red circle",
        "negative_prompt": "",
        "checkpoint": "example.safetensors [abcd]",
        "sampler_name": "Euler",
        "scheduler": "automatic",
        "width": 512,
        "height": 512,
        "steps": 8,
        "cfg_scale": 5.5,
        "seed": 7,
        "n_iter": 1,
        "batch_size": 1,
    }


class Gallery(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(self.id().replace(".", "_"))
        # Unique temp under the system temp via TemporaryDirectory would be cleaner.
        import tempfile
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        G.reset_for_tests()

    def tearDown(self) -> None:
        G.reset_for_tests()
        self.tmp.cleanup()

    def _export(self) -> bytes:
        archive = G.export_archive(self.root)
        try:
            return archive.read_bytes()
        finally:
            archive.unlink(missing_ok=True)

    def test_store_rewrites_pixels_and_hides_paths(self):
        saved = G.store(self.root, _png(), _settings())
        folder = G.gallery_dir(self.root) / saved["id"]
        self.assertTrue((folder / "original.png").is_file())
        self.assertTrue((folder / "thumb.jpg").is_file())
        blob = (folder / "meta.json").read_text(encoding="utf-8")
        self.assertNotIn("filename", blob)
        self.assertNotIn("\\", blob)
        detail = G.get(self.root, saved["id"])
        self.assertEqual(detail["settings"]["prompt"], "a red circle")
        self.assertTrue(detail["original"].endswith("/original"))

    def test_rejects_non_images_and_paths_in_settings(self):
        with self.assertRaises(G.GalleryError) as raised:
            G.store(self.root, b"not-an-image", _settings())
        self.assertEqual(raised.exception.code, "bad_image")
        bad = _settings()
        bad["checkpoint"] = r"C:\secret\model.safetensors"
        with self.assertRaises(G.GalleryError):
            G.store(self.root, _png(), bad)
        self.assertEqual(list(G.gallery_dir(self.root).glob("img-*")), [])

    def test_quota_does_not_delete_the_existing_image(self):
        G.set_quota_for_tests(image_cap=1)
        first = G.store(self.root, _png(), _settings())
        with self.assertRaises(G.GalleryError) as raised:
            G.store(self.root, _png(), _settings())
        self.assertEqual(raised.exception.code, "quota")
        self.assertTrue((G.gallery_dir(self.root) / first["id"] / "original.png").is_file())

    def test_delete_and_escape_refuse_to_leave_the_gallery(self):
        saved = G.store(self.root, _png(), _settings())
        outside = self.root / "keep.txt"
        outside.write_text("keep", encoding="utf-8")
        self.assertEqual(G.delete(self.root, saved["id"])["deleted"], saved["id"])
        self.assertFalse((G.gallery_dir(self.root) / saved["id"]).exists())
        self.assertTrue(outside.is_file())
        with self.assertRaises(G.GalleryError):
            G.delete(self.root, "../keep.txt")
        with self.assertRaises(G.GalleryError):
            G.file_bytes(self.root, "img-" + "ab" * 12, "original")

    def test_disk_full_leaves_no_image(self):
        original = G._atomic_bytes

        def boom(path, payload):
            raise G.GalleryError("disk")

        G._atomic_bytes = boom
        try:
            with self.assertRaises(G.GalleryError) as raised:
                G.store(self.root, _png(), _settings())
            self.assertEqual(raised.exception.code, "disk")
        finally:
            G._atomic_bytes = original
        self.assertEqual(list(G.gallery_dir(self.root).glob("img-*")), [])
        ids = [G.store(self.root, _png(64, 64), _settings())["id"] for _ in range(3)]
        first = G.page(self.root, limit=2)
        self.assertEqual(len(first["images"]), 2)
        self.assertIsNotNone(first["next_cursor"])
        second = G.page(self.root, limit=2, cursor=first["next_cursor"])
        self.assertEqual(len(second["images"]), 1)
        self.assertEqual({item["id"] for item in first["images"] + second["images"]}, set(ids))
        payload, ctype, disposition = G.file_bytes(self.root, ids[0], "original")
        self.assertEqual(ctype, "image/png")
        self.assertIn(f'filename="forge-{ids[0]}.png"', disposition)
        self.assertNotIn("secret", disposition)
        self.assertTrue(payload.startswith(b"\x89PNG"))
        text = json.dumps(G.page(self.root, limit=10))
        self.assertNotIn("prompt", text)

    def test_non_finite_hires_numbers_do_not_change_gallery_metadata(self):
        settings = _settings()
        settings.update(enable_hr=True, hr_scale=1.5, hr_upscaler="R-ESRGAN 4x+", hr_second_pass_steps=8, denoising_strength=0.4)
        saved = G.store(self.root, _png(), settings)
        meta = G.gallery_dir(self.root) / saved["id"] / "meta.json"
        before = meta.read_bytes()
        self.assertIn(b"0.4", before)
        for value in (float("nan"), float("inf"), float("-inf")):
            for field in ("denoising_strength", "hr_scale"):
                bad = dict(settings)
                bad[field] = value
                with self.assertRaises(G.GalleryError) as raised:
                    G.store(self.root, _png(), bad)
                self.assertEqual(raised.exception.code, "bad_image")
        self.assertEqual(meta.read_bytes(), before)
        self.assertEqual(len(list(G.gallery_dir(self.root).glob("img-*"))), 1)
        self.assertNotIn("NaN", meta.read_text(encoding="utf-8"))
        self.assertNotIn("Infinity", meta.read_text(encoding="utf-8"))


    def test_history_page_searches_every_retained_image_and_respects_deletion(self):
        ids = []
        for index in range(30):
            settings = _settings()
            settings["prompt"] = ("phare ancien" if index == 0 else "forêt n" + str(index))
            ids.append(G.store(self.root, _png(64, 64), settings)["id"])
        first = G.history_page(self.root, limit=5)
        self.assertEqual(len(first["entries"]), 5)
        self.assertEqual(first["total"], 30)
        self.assertIn("prompt", first["entries"][0]["settings"])
        found = G.history_page(self.root, limit=5, query="PHARE")
        self.assertEqual([item["id"] for item in found["entries"]], [ids[0]])
        self.assertEqual(found["total"], 1)
        self.assertEqual(G.history_page(self.root, query="zzz-absent")["entries"], [])
        G.delete(self.root, ids[0])
        self.assertEqual(G.history_page(self.root, query="phare")["entries"], [])
        self.assertNotIn("prompt", json.dumps(G.page(self.root, limit=10)))

    def test_page_reports_usage_and_the_bin_counts_against_the_quota(self):
        G.set_quota_for_tests(image_cap=4)
        first = G.store(self.root, _png(64, 64), _settings())
        G.set_triage(self.root, first["id"], "reject")
        page = G.page(self.root, view="trash")
        self.assertEqual([item["id"] for item in page["images"]], [first["id"]])
        usage = page["usage"]
        self.assertEqual((usage["images"], usage["quota_images"], usage["quota_bytes"]), (1, 4, G.QUOTA_BYTES))
        self.assertGreater(usage["bytes"], 0)
        self.assertEqual(usage["export_images"], 1)
        self.assertGreater(usage["export_bytes"], 0)
        self.assertGreaterEqual(usage["export_limit_bytes"], 0)

    def test_export_import_round_trip_keeps_settings_and_flags(self):
        first = G.store(self.root, _png(64, 64), _settings())
        G.set_triage(self.root, first["id"], "favorite")
        blob = self._export()
        self.assertTrue(blob.startswith(b"PK"))
        G.delete(self.root, first["id"])
        self.assertEqual(G.page(self.root)["images"], [])
        result = G.import_zip(self.root, blob)
        self.assertEqual((result["imported"], result["skipped"], result["quota"]), (1, 0, False))
        restored = G.page(self.root)["images"][0]
        self.assertEqual(restored["triage"], "favorite")
        detail = G.get(self.root, restored["id"])
        self.assertEqual(detail["settings"]["prompt"], "a red circle")
        self.assertTrue((G.gallery_dir(self.root) / restored["id"] / "original.png").is_file())

    def test_a_second_export_is_refused_while_one_is_running(self):
        G.store(self.root, _png(64, 64), _settings())
        original = G._free_bytes
        G._free_bytes = lambda root: 10 * 1024 ** 3
        G._EXPORT_LOCK.acquire()
        try:
            with self.assertRaises(G.GalleryError) as raised:
                G.export_archive(self.root)
            self.assertEqual(raised.exception.code, "busy")
        finally:
            G._EXPORT_LOCK.release()
            G._free_bytes = original

    def test_cleanup_exports_only_removes_its_own_stale_archives(self):
        exports = Path(self.root) / ".hq-forge" / G.EXPORT_DIR
        exports.mkdir(parents=True)
        stale = exports / ("export-" + "0" * 16 + ".zip")
        stale.write_bytes(b"PK")
        keep = exports / "keep.txt"
        keep.write_bytes(b"keep")
        G.cleanup_exports(self.root, max_age=-1)
        self.assertFalse(stale.exists())
        self.assertTrue(keep.is_file())

    def test_export_plan_states_the_disk_limit_before_anything_is_written(self):
        G.store(self.root, _png(64, 64), _settings())
        original = G._free_bytes
        try:
            G._free_bytes = lambda root: 0
            plan = G.export_plan(self.root)
            self.assertEqual((plan["images"], plan["limit_bytes"], plan["allowed"]), (1, 0, False))
            with self.assertRaises(G.GalleryError) as raised:
                G.export_archive(self.root)
            self.assertEqual(raised.exception.code, "too_large")
            exports = Path(self.root) / ".hq-forge" / G.EXPORT_DIR
            self.assertEqual(list(exports.glob("export-*.zip")), [])
            G._free_bytes = lambda root: 10 * 1024 ** 3
            plan = G.export_plan(self.root)
            self.assertTrue(plan["allowed"])
            self.assertGreater(plan["bytes"], 0)
            archive = G.export_archive(self.root)
            try:
                self.assertTrue(archive.is_file())
                self.assertEqual(archive.parent.name, G.EXPORT_DIR)
                self.assertEqual(archive.read_bytes()[:2], b"PK")
            finally:
                archive.unlink(missing_ok=True)
        finally:
            G._free_bytes = original

    def test_import_refuses_a_bad_archive_and_stops_at_the_quota(self):
        import zipfile
        with self.assertRaises(G.GalleryError) as raised:
            G.import_zip(self.root, b"not a zip")
        self.assertEqual(raised.exception.code, "bad_zip")
        escape = io.BytesIO()
        with zipfile.ZipFile(escape, "w") as archive:
            archive.writestr("../escape.png", b"x")
        with self.assertRaises(G.GalleryError):
            G.import_zip(self.root, escape.getvalue())
        self.assertFalse((self.root / "escape.png").exists())
        ids = [G.store(self.root, _png(64, 64), _settings())["id"] for _ in range(3)]
        full = self._export()
        for image_id in ids:
            G.delete(self.root, image_id)
        G.set_quota_for_tests(image_cap=2)
        result = G.import_zip(self.root, full)
        self.assertEqual((result["imported"], result["quota"]), (2, True))
        self.assertEqual(len(G.page(self.root)["images"]), 2)

    def _zip_path(self, blob: bytes) -> Path:
        path = Path(self.root) / ("restore-" + str(len(blob)) + ".zip")
        path.write_bytes(blob)
        return path

    def test_restore_refuses_atomically_when_the_quota_cannot_fit(self):
        ids = [G.store(self.root, _png(), _settings())["id"] for _ in range(3)]
        path = self._zip_path(self._export())
        for image_id in ids:
            G.delete(self.root, image_id)
        G.set_quota_for_tests(image_cap=2)
        plan = G.restore_plan_path(self.root, path)
        self.assertEqual((plan["images"], plan["allowed"]), (3, False))
        with self.assertRaises(G.GalleryError) as raised:
            G.import_zip_path(self.root, path)
        self.assertEqual(raised.exception.code, "quota")
        self.assertEqual(G.page(self.root)["images"], [], "a refused restore writes nothing")

    def test_restore_skips_byte_identical_images(self):
        G.store(self.root, _png(), _settings())
        path = self._zip_path(self._export())
        result = G.import_zip_path(self.root, path)
        self.assertEqual((result["imported"], result["duplicates"]), (0, 1))
        self.assertEqual(len(G.page(self.root)["images"]), 1)

    def test_verify_reads_the_archive_without_storing(self):
        saved = G.store(self.root, _png(), _settings())
        path = self._zip_path(self._export())
        G.delete(self.root, saved["id"])
        result = G.import_zip_path(self.root, path, verify=True)
        self.assertEqual((result["verified"], result["imported"]), (1, 0))
        self.assertEqual(G.page(self.root)["images"], [])

    def test_backup_marker_and_subset_export(self):
        import time
        import zipfile
        first = G.store(self.root, _png(), _settings())
        second = G.store(self.root, _png(), _settings())
        archive = G.export_archive(self.root, ids=[first["id"]])
        try:
            with zipfile.ZipFile(archive) as bundle:
                names = bundle.namelist()
            self.assertTrue(any(name.startswith(first["id"] + "/") for name in names))
            self.assertFalse(any(name.startswith(second["id"] + "/") for name in names))
        finally:
            archive.unlink(missing_ok=True)
        G.mark_backup(self.root, G.export_plan(self.root))
        status = G.usage(self.root)["backup"]
        self.assertTrue(status["at"])
        self.assertEqual(status["images"], 2)
        time.sleep(1.05)
        G.store(self.root, _png(), _settings())
        self.assertEqual(G.usage(self.root)["backup"]["since_images"], 1)

    def test_empty_trash_deletes_only_rejected_images(self):
        kept = G.store(self.root, _png(), _settings())
        rejected = G.store(self.root, _png(), _settings())
        G.set_triage(self.root, rejected["id"], "reject")
        G.set_triage(self.root, kept["id"], "keep")
        self.assertEqual(G.empty_trash(self.root)["deleted"], 1)
        with self.assertRaises(G.GalleryError):
            G.get(self.root, rejected["id"])
        self.assertEqual([row["id"] for row in G.page(self.root)["images"]], [kept["id"]])

    def test_backup_marker_not_written_by_export_plan_or_archive_alone(self):
        G.store(self.root, _png(), _settings())
        path = G.export_archive(self.root)
        try:
            before = G.usage(self.root)["backup"]["at"]
            G.export_plan(self.root)
            self.assertEqual(G.usage(self.root)["backup"]["at"], before)
        finally:
            path.unlink(missing_ok=True)
        self.assertEqual(G.usage(self.root)["backup"]["at"], before)

    def test_mark_backup_idempotent_last_write_wins(self):
        G.store(self.root, _png(), _settings())
        plan = G.export_plan(self.root)
        first = G.mark_backup(self.root, plan)
        second = G.mark_backup(self.root, plan)
        self.assertTrue(first["at"])
        self.assertTrue(second["at"])
        self.assertGreaterEqual(second["at"], first["at"])

    def test_mark_backup_rejects_non_dict_plan(self):
        G.store(self.root, _png(), _settings())
        marked = G.mark_backup(self.root, {"images": 1, "bytes": 10})
        self.assertTrue(marked["at"])
        self.assertEqual(marked["images"], 1)


if __name__ == "__main__":
    unittest.main()
