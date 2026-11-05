"""Carnet Stage 06 — note images: confined storage, bounded upload, structural validation, lifecycle, backup, export.

Throwaway ROOTs only (run from a disposable source copy: the HTTP part imports the bridge).
Browser behaviour: tests/check_hq_carnet_media.mjs (pure model) and tests/visual_carnet_media_playwright.mjs.
"""

from __future__ import annotations

import io
import json
import os
import re
import socket
import sys
import threading
import time
import tracemalloc
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import carnet_media_fixtures as F  # noqa: E402
import cc_ext  # noqa: E402
import hq_carnet  # noqa: E402
import hq_carnet_media as media  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_state  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet_history import Stage08Base, para as _para08  # noqa: E402,F401
from test_hq_carnet import ApiTests as _ApiBase  # noqa: E402
from test_hq_carnet import CarnetBase, NOW, _dir_symlink, _file_symlink, _fixture, _http  # noqa: E402

try:
    import test_backup_retention as _retention
except ImportError:  # pragma: no cover
    from tests import test_backup_retention as _retention

MIB = 1024 * 1024


def upload(data: bytes, declared: str | None = None) -> dict:
    return media.store_upload(io.BytesIO(data).read, len(data), declared)["asset"]


def image_block(asset: dict, *, width=60, caption="", block_id=None, layout="inline") -> dict:
    block = {
        "type": "image", "text": "", "marks": [],
        "asset": {"id": asset["id"], "mime": asset["mime"], "w": asset["w"], "h": asset["h"], "width": width, "layout": layout, "caption": caption},
    }
    if block_id:
        block["id"] = block_id
    return block


def para(text="x", **extra):
    return {"type": "paragraph", "text": text, "marks": [], **extra}


class MediaBase(CarnetBase):
    def setUp(self):
        super().setUp()
        saved = dict(media._cb)
        self.addCleanup(lambda: (media._cb.clear(), media._cb.update(saved)))
        for name in ("Inbox", "Uni", "Print"):
            (self.tmp / name).mkdir()
        import iphone_bridge as B

        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=B.SYSTEM_NAMES, safe_leaf_name=B.safe_leaf_name)
        self.adir = self.tmp / ".hq-carnet" / "assets"

    def files(self) -> list[str]:
        return sorted(os.listdir(self.adir)) if self.adir.is_dir() else []

    def new_page(self) -> dict:
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        return nb["page"]

    def save_blocks(self, page: dict, blocks: list[dict]) -> dict:
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"],
                                 "content": {"version": 2, "blocks": blocks}})["page"]


# ---------------------------------------------------------------- structural validation (pure)


class ParseTests(unittest.TestCase):
    def inspect(self, data: bytes):
        return media.inspect_file(io.BytesIO(data), len(data))

    def refuse(self, data: bytes, code: str | None = None, status: int | None = None):
        with self.assertRaises(media.MediaError) as cm:
            self.inspect(data)
        if code:
            self.assertEqual(cm.exception.code, code)
        if status:
            self.assertEqual(cm.exception.status, status)
        return cm.exception

    def test_valid_png_jpeg_webp(self):
        self.assertEqual(self.inspect(F.png(33, 17)), ("image/png", 33, 17))
        self.assertEqual(self.inspect(F.png(5, 5, color=6)), ("image/png", 5, 5))
        self.assertEqual(self.inspect(F.jpeg(40, 25)), ("image/jpeg", 40, 25))
        self.assertEqual(self.inspect(F.jpeg(16, 16, progressive=True)), ("image/jpeg", 16, 16))
        self.assertEqual(self.inspect(F.webp_vp8l(12, 9)), ("image/webp", 12, 9))
        self.assertEqual(self.inspect(F.webp_vp8(10, 11)), ("image/webp", 10, 11))
        self.assertEqual(self.inspect(F.webp_real_1x1()), ("image/webp", 1, 1))

    def test_dimension_bounds(self):
        self.assertEqual(self.inspect(F.png(2560, 10))[1:], (2560, 10))
        self.assertEqual(self.inspect(F.jpeg(10, 2560))[1:], (10, 2560))
        for data in (F.png(2561, 10), F.jpeg(10, 2561), F.webp_vp8l(2561, 4)):
            self.refuse(data, "image_dimensions", 413)
        self.refuse(b"\x89PNG\r\n\x1a\n")  # signature only

    def test_bad_magic_and_unsupported_types(self):
        for data in (b"", b"\x00" * 64, b"GIF89a" + b"\x00" * 40, b"<svg xmlns='http://www.w3.org/2000/svg'/>",
                     b"RIFF\x10\x00\x00\x00WAVEfmt " + b"\x00" * 8, b"%PDF-1.4 " + b"\x00" * 30, b"\x00\x00\x00\x18ftypheic" + b"\x00" * 30):
            err = self.refuse(data)
            self.assertIn(err.code, ("unsupported_type", "file_too_large"))

    def test_truncated_and_corrupt(self):
        for data in (F.png(20, 20, truncate=1), F.png(20, 20, truncate=12), F.png(20, 20, bad_crc=True), F.png(20, 20)[:40], F.png(20, 20) + b"\x00",
                     F.jpeg(20, 20, truncate=1), F.jpeg(20, 20, eoi=False), F.jpeg(20, 20)[:30], F.jpeg(20, 20) + b"\x00",
                     F.webp_vp8l(8, 8)[:-3], F.webp_vp8l(8, 8, size_delta=2), F.webp_vp8l(8, 8, size_delta=-2)):
            self.refuse(data)

    def test_extension_irrelevant_content_decides(self):
        # the server never sees a file name: a PNG renamed to .jpg is still a PNG, a JPEG body is never a PNG
        self.assertEqual(self.inspect(F.png())[0], "image/png")
        self.assertEqual(self.inspect(F.jpeg())[0], "image/jpeg")

    def test_animated_and_unsupported_variants_refused(self):
        self.refuse(F.png(4, 4, animated=True), "unsupported_image", 415)
        self.refuse(F.webp_vp8l(4, 4, animated=True), "unsupported_image", 415)
        self.refuse(F.jpeg(16, 16, components=4), "unsupported_image", 415)

    def test_jpeg_orientation_contract(self):
        # absent and explicit 1 pass; 2..8 are refused with a dedicated code (no dimension reinterpretation)
        self.assertEqual(self.inspect(F.jpeg(16, 16))[0], "image/jpeg")
        self.assertEqual(self.inspect(F.jpeg(16, 8, orientation=1))[1:], (16, 8))
        self.assertEqual(self.inspect(F.jpeg(16, 8, exif=F.tiff_exif(None)))[1:], (16, 8))  # EXIF without orientation
        self.assertEqual(self.inspect(F.jpeg(16, 8, exif=F.tiff_exif(1, endian=">")))[1:], (16, 8))
        for value in range(2, 9):
            for endian in ("<", ">"):
                err = self.refuse(F.jpeg(16, 8, exif=F.tiff_exif(value, endian=endian)), "exif_orientation", 415)
                self.assertNotIn("\\", str(err))

    def test_jpeg_malformed_exif_rejected_safely(self):
        good = F.tiff_exif(1)
        bad_blocks = [
            b"Exif\x00\x00",                                  # empty payload
            b"Exif\x00\x00II",                                # truncated header
            b"Exif\x00\x00XX" + good[8:],                     # bad byte order
            good[:6] + b"II" + b"\x2b\x00" + good[10:],       # wrong magic
            good[:6] + good[6:10] + b"\xff\xff\xff\x7f" + good[14:],  # IFD offset beyond the block
            F.tiff_exif(0),                                   # orientation 0
            F.tiff_exif(9),                                   # orientation out of range
            good[:-8],                                        # truncated IFD
            F.tiff_exif(1)[:12] + b"\xff\xff" + F.tiff_exif(1)[14:],  # absurd entry count
        ]
        for block in bad_blocks:
            err = self.refuse(F.jpeg(16, 8, exif=block))
            self.assertIn(err.code, ("bad_exif", "exif_orientation"))
        # wrong type/count on the orientation tag
        bad_type = bytearray(F.tiff_exif(1))
        bad_type[6 + 10 + 2 : 6 + 10 + 4] = b"\x04\x00"  # type LONG instead of SHORT
        self.refuse(F.jpeg(16, 8, exif=bytes(bad_type)), "bad_exif")
        self.refuse(F.jpeg(16, 8, exif=F.tiff_exif(1), two_exif=True), "bad_exif")  # ambiguous: two Exif segments

    def test_png_and_webp_exif_orientation_contract(self):
        self.assertEqual(self.inspect(F.png(8, 8, exif=F.tiff_exif(1)))[0], "image/png")
        self.refuse(F.png(8, 8, exif=F.tiff_exif(6)), "exif_orientation")
        self.refuse(F.png(8, 8, exif=b"garbage!"), "bad_exif")
        self.assertEqual(self.inspect(F.webp_vp8l(8, 8, exif=F.tiff_exif(1)))[0], "image/webp")
        self.refuse(F.webp_vp8l(8, 8, exif=F.tiff_exif(3)), "exif_orientation")
        self.refuse(F.webp_vp8l(8, 8, exif=b"garbage!"), "bad_exif")

    def test_per_file_size(self):
        self.assertEqual(self.inspect(F.png_of_size(media.MAX_FILE_BYTES))[0], "image/png")
        self.refuse(F.png_of_size(media.MAX_FILE_BYTES + 1), "file_too_large", 413)

    def test_inspection_memory_is_bounded(self):
        data = F.png_of_size(media.MAX_FILE_BYTES)
        tracemalloc.start()
        try:
            self.inspect(data)
            _cur, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 1 * MIB, "a 12 MiB PNG must be walked with bounded chunks, not loaded")


# ---------------------------------------------------------------- storage / upload


class UploadTests(MediaBase):
    def test_valid_uploads_are_generated_opaque_and_typed(self):
        ids = set()
        for data, mime, ext in ((F.jpeg(30, 20), "image/jpeg", ".jpg"), (F.png(12, 9), "image/png", ".png"), (F.webp_vp8l(7, 5), "image/webp", ".webp")):
            asset = upload(data, mime)
            self.assertRegex(asset["id"], r"^asset-[0-9a-f]{24}$")
            self.assertEqual((asset["mime"], asset["bytes"]), (mime, len(data)))
            ids.add(asset["id"])
            self.assertTrue((self.adir / (asset["id"] + ext)).is_file())
            self.assertEqual((self.adir / (asset["id"] + ext)).read_bytes(), data)
        self.assertEqual(len(ids), 3)
        self.assertTrue(all(re.match(r"^asset-[0-9a-f]{24}\.(jpg|png|webp)$", n) for n in self.files()))

    def test_declared_mime_mismatch_and_unknown_declared(self):
        for data, wrong in ((F.png(), "image/jpeg"), (F.jpeg(), "image/png"), (F.webp_vp8l(), "image/png")):
            with self.assertRaises(media.MediaError) as cm:
                upload(data, wrong)
            self.assertEqual((cm.exception.code, cm.exception.status), ("mime_mismatch", 415))
        with self.assertRaises(media.MediaError) as cm:
            upload(F.png(), "image/heic")
        self.assertEqual(cm.exception.code, "unsupported_type")
        with self.assertRaises(media.MediaError) as cm:
            upload(F.png(), "text/html")
        self.assertEqual(cm.exception.code, "unsupported_type")
        self.assertEqual(self.files(), [])

    def test_refusals_leave_no_residue(self):
        for data in (b"not an image" * 10, F.png(9, 9, bad_crc=True), F.jpeg(9, 9, eoi=False), F.png(2561, 9),
                     F.jpeg(16, 8, orientation=6), F.webp_vp8l(8, 8, animated=True)):
            with self.assertRaises(media.MediaError):
                upload(data)
        self.assertEqual(self.files(), [])

    def test_length_validation(self):
        for bad in (0, -1, None, "5", True, 1.5):
            with self.assertRaises(media.MediaError) as cm:
                media.store_upload(io.BytesIO(b"x").read, bad, None)
            self.assertEqual(cm.exception.code, "bad_length")
        with self.assertRaises(media.MediaError) as cm:
            media.store_upload(lambda n: b"", media.MAX_FILE_BYTES + 1, None)  # refused before a single byte is read
        self.assertEqual((cm.exception.code, cm.exception.status), ("file_too_large", 413))

    def test_oversize_refused_before_reading_anything(self):
        calls = []
        with self.assertRaises(media.MediaError):
            media.store_upload(lambda n: calls.append(n) or b"", media.MAX_FILE_BYTES + 1, None)
        self.assertEqual(calls, [])
        self.assertFalse(self.adir.exists(), "a refused oversize upload must not even create the directory")

    def test_body_longer_than_declared_is_refused(self):
        data = F.png()

        def greedy(n):
            return b"\x00" * (n + 5)

        with self.assertRaises(media.MediaError):
            media.store_upload(greedy, len(data), None)
        self.assertEqual(self.files(), [])

    def test_interrupted_upload_cleans_temp(self):
        data = F.png(10, 10)
        src = io.BytesIO(data[:20])
        with self.assertRaises(media.MediaError) as cm:
            media.store_upload(src.read, len(data), None)
        self.assertEqual(cm.exception.code, "interrupted")
        self.assertEqual(self.files(), [])
        self.assertEqual(media._reserved, {})

        calls = {"n": 0}

        def dies(n):
            calls["n"] += 1
            if calls["n"] > 1:
                raise ConnectionResetError("boom")
            return data[:10]

        with self.assertRaises(media.MediaError) as cm:
            media.store_upload(dies, len(data), None)
        self.assertEqual(cm.exception.status, 503)
        self.assertNotIn(str(self.tmp), str(cm.exception))
        self.assertEqual(self.files(), [])

    def test_finalisation_is_atomic_and_fault_safe(self):
        data = F.png(10, 10)
        seen_during = []
        real_replace = os.replace

        def spying_replace(src, dst):
            seen_during.append(sorted(n for n in os.listdir(self.adir) if not n.startswith(".tmp-")))
            return real_replace(src, dst)

        with mock.patch.object(os, "replace", side_effect=spying_replace):
            asset = upload(data)
        self.assertEqual(seen_during, [[]], "the final name must not exist before the atomic replace")
        self.assertEqual(self.files(), [asset["id"] + ".png"])
        with mock.patch.object(os, "replace", side_effect=OSError("disk says no")):
            with self.assertRaises(media.MediaError) as cm:
                upload(F.png(11, 11))
        self.assertEqual(cm.exception.status, 503)
        self.assertNotIn(str(self.tmp), str(cm.exception))
        self.assertEqual(self.files(), [asset["id"] + ".png"])  # the failed upload left no temp behind

    def test_stale_temp_is_cleaned_but_fresh_temp_survives(self):
        self.adir.mkdir(parents=True)
        stale = self.adir / ".tmp-deadbeef"
        stale.write_bytes(b"x" * 10)
        old = time.time() - media.STALE_TMP_SECONDS - 60
        os.utime(stale, (old, old))
        fresh = self.adir / ".tmp-fresh"
        fresh.write_bytes(b"y")
        upload(F.png())
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())

    def test_no_client_value_reaches_the_filesystem(self):
        # store_upload takes bytes + a MIME hint only: file names/paths do not exist in its interface
        import inspect

        self.assertEqual(list(inspect.signature(media.store_upload).parameters), ["read", "length", "declared_mime"])
        upload(F.png(), "image/png")
        self.assertTrue(all(n.startswith("asset-") for n in self.files()))

    def test_unrelated_files_are_never_touched_or_counted(self):
        self.adir.mkdir(parents=True)
        (self.adir / "notes.txt").write_text("mine", encoding="utf-8")
        upload(F.png())
        self.assertEqual((self.adir / "notes.txt").read_text(encoding="utf-8"), "mine")
        self.assertEqual(media.usage()["files"], 1)


class ConfinementTests(MediaBase):
    def test_asset_id_path_tricks_are_404(self):
        asset = upload(F.png())
        good = asset["id"]
        (self.tmp / "secret.jpg").write_bytes(F.jpeg())
        tricks = [
            "../secret", "..\\secret", good + "/../x", "/etc/passwd", "C:\\Windows\\win.ini", "C:/Windows/win.ini", "\\\\host\\share\\x",
            "%2e%2e%2fsecret", "..%2fsecret", "%5c..%5csecret", good + "%00", good + "\x00.png", good + ".png", good.upper(),
            "asset-" + "0" * 23, "asset-" + "0" * 25, "asset-" + "g" * 24, "", " " + good, good + " ", "./" + good, good + "/", "asset-../x",
            "asset-" + "0" * 24 + ".jpg/../../secret",
        ]
        for trick in tricks:
            with self.assertRaises(media.MediaError) as cm:
                media.open_asset(trick)
            self.assertEqual(cm.exception.status, 404, repr(trick))
            self.assertNotIn(str(self.tmp), str(cm.exception))
        handle, mime, size = media.open_asset(good)
        handle.close()
        self.assertEqual((mime, size), ("image/png", len(F.png())))

    def test_symlinked_asset_dir_is_refused_and_never_followed(self):
        outside = self.tmp / "outside"
        outside.mkdir()
        (self.tmp / ".hq-carnet").mkdir()
        _dir_symlink(outside, self.adir)
        with self.assertRaises(media.MediaError) as cm:
            upload(F.png())
        self.assertEqual(cm.exception.status, 409)
        self.assertNotIn(str(self.tmp), str(cm.exception))
        self.assertEqual(os.listdir(outside), [])

    def test_symlinked_carnet_dir_is_refused(self):
        outside = self.tmp / "outside"
        outside.mkdir()
        _dir_symlink(outside, self.tmp / ".hq-carnet")
        with self.assertRaises(media.MediaError):
            upload(F.png())
        self.assertEqual(os.listdir(outside), [])

    def test_symlinked_asset_file_is_not_served_nor_counted_as_bytes(self):
        asset = upload(F.png())
        outside = self.tmp / "outside.png"
        outside.write_bytes(F.png(4, 4))
        victim = self.adir / ("asset-" + "a" * 24 + ".png")
        _file_symlink(outside, victim)
        with self.assertRaises(media.MediaError) as cm:
            media.open_asset("asset-" + "a" * 24)
        self.assertEqual(cm.exception.status, 404)
        usage = media.usage()
        self.assertEqual(usage["bytes"], len(F.png()))  # the link contributes no bytes...
        self.assertEqual(usage["files"], 2)             # ...but still counts as an entry (bounded)
        self.assertEqual(asset["bytes"], len(F.png()))

    def test_toctou_swap_to_symlink_after_upload_is_not_followed(self):
        asset = upload(F.png())
        final = self.adir / (asset["id"] + ".png")
        outside = self.tmp / "outside.png"
        outside.write_bytes(F.png(3, 3))
        final.unlink()
        _file_symlink(outside, final)
        with self.assertRaises(media.MediaError):
            media.open_asset(asset["id"])


class QuotaTests(MediaBase):
    def test_total_quota_is_explicit_and_understandable(self):
        with mock.patch.object(media, "MAX_TOTAL_BYTES", 400):
            first = upload(F.png(8, 6))
            size = len(F.png(8, 6))
            while media.usage()["bytes"] + size <= 400:
                upload(F.png(8, 6))
            with self.assertRaises(media.MediaError) as cm:
                upload(F.png(8, 6))
        err = cm.exception
        self.assertEqual((err.status, err.code), (409, "quota_exceeded"))
        self.assertIn("Quota des images atteint", str(err))
        self.assertIn("il n'existe pas encore de nettoyage", str(err))  # says WHY space is not freed
        self.assertNotIn(str(self.tmp), str(err))
        self.assertTrue(first["id"])

    def test_file_count_quota(self):
        with mock.patch.object(media, "MAX_FILES", 3):
            for _ in range(3):
                upload(F.png())
            with self.assertRaises(media.MediaError) as cm:
                upload(F.png())
        self.assertEqual(cm.exception.code, "quota_exceeded")

    def test_orphans_consume_quota_and_nothing_is_deleted(self):
        page = self.new_page()
        asset = upload(F.png(20, 20))
        page = self.save_blocks(page, [para("a"), image_block(asset)])
        used_before = media.usage()["bytes"]
        page = self.save_blocks(page, [para("a")])  # the image block is removed
        self.assertEqual(self.files(), [asset["id"] + ".png"], "removing a block never deletes the asset")
        self.assertEqual(media.usage()["bytes"], used_before, "an orphan keeps consuming the quota")
        with mock.patch.object(media, "MAX_TOTAL_BYTES", used_before):
            with self.assertRaises(media.MediaError) as cm:
                upload(F.png(8, 8))
        self.assertEqual(cm.exception.code, "quota_exceeded")

    def test_concurrent_quota_race_admits_exactly_what_fits(self):
        data = F.png(8, 8)
        room = 2  # the quota fits exactly two files
        results, barrier = [], threading.Barrier(6)
        slow = threading.Event()

        def slow_reader(n, src=io.BytesIO(data)):
            return src.read(n)

        def worker():
            src = io.BytesIO(data)
            barrier.wait()
            try:
                asset = media.store_upload(src.read, len(data), None)["asset"]
                results.append(("ok", asset["id"]))
            except media.MediaError as e:
                results.append(("err", e.code))

        with mock.patch.object(media, "MAX_TOTAL_BYTES", len(data) * room), mock.patch.object(media, "_slots", threading.BoundedSemaphore(6)):
            threads = [threading.Thread(target=worker) for _ in range(6)]
            for t in threads:
                t.start()
            for t in threads:
                t.join(20)
        oks = [r for r in results if r[0] == "ok"]
        self.assertEqual(len(oks), room, results)
        self.assertEqual({r[1] for r in results if r[0] == "err"}, {"quota_exceeded"})
        self.assertEqual(len(self.files()), room)
        self.assertEqual(media._reserved, {})
        del slow, slow_reader

    def test_in_flight_reservation_counts_against_quota(self):
        data = F.png(8, 8)
        gate, started = threading.Event(), threading.Event()

        def blocked_reader(n, _src=io.BytesIO(data)):
            started.set()
            gate.wait(10)
            return _src.read(n)

        result = {}
        with mock.patch.object(media, "MAX_TOTAL_BYTES", len(data)):
            t = threading.Thread(target=lambda: result.update(media.store_upload(blocked_reader, len(data), None)))
            t.start()
            self.assertTrue(started.wait(10))
            with self.assertRaises(media.MediaError) as cm:  # the first upload has only reserved its bytes so far
                upload(data)
            self.assertEqual(cm.exception.code, "quota_exceeded")
            gate.set()
            t.join(10)
        self.assertTrue(result["ok"])
        self.assertEqual(len(self.files()), 1)

    def test_concurrent_upload_slots_are_bounded(self):
        data = F.png(8, 8)
        gate, started = threading.Event(), threading.Semaphore(0)

        def blocked(n, _src=None):
            started.release()
            gate.wait(10)
            return b""

        threads = [threading.Thread(target=lambda: self._try(blocked, data)) for _ in range(media.CONCURRENT_UPLOADS)]
        for t in threads:
            t.start()
        for _ in threads:
            self.assertTrue(started.acquire(timeout=10))
        with self.assertRaises(media.MediaError) as cm:
            upload(data)
        self.assertEqual((cm.exception.status, cm.exception.code), (429, "busy"))
        gate.set()
        for t in threads:
            t.join(10)
        upload(data)  # slots are released on every path
        self.assertEqual(media._reserved, {})

    def _try(self, reader, data):
        try:
            media.store_upload(reader, len(data), None)
        except media.MediaError:
            pass

    def test_double_submit_creates_two_independent_assets(self):
        data = F.png(8, 8)
        a, b = upload(data), upload(data)
        self.assertNotEqual(a["id"], b["id"])
        self.assertEqual(len(self.files()), 2)
        self.assertEqual(media.usage()["bytes"], 2 * len(data))  # both count: the UI in-flight guard prevents this

    def test_large_upload_memory_is_bounded(self):
        data = F.png_of_size(11 * MIB)
        src = io.BytesIO(data)
        tracemalloc.start()
        try:
            media.store_upload(src.read, len(data), "image/png")
            _cur, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertLess(peak, 2 * MIB, "an 11 MiB upload must stream in bounded chunks")


# ---------------------------------------------------------------- content model / page_save


class ContentTests(MediaBase):
    def test_aligned_images_roundtrip_and_a_reorder_keeps_ids_in_one_revision(self):
        page = self.new_page()
        a = upload(F.png(10, 8))
        page = self.save_blocks(page, [image_block(a, layout="center", width=70), para("texte"), image_block(a, layout="right", width=40, caption="d")])
        blocks = page["content"]["blocks"]
        self.assertEqual([b["asset"]["layout"] for b in blocks if b["type"] == "image"], ["center", "right"])
        self.assertEqual([b["asset"]["width"] for b in blocks if b["type"] == "image"], [70, 40])
        ids = [b["id"] for b in blocks]
        # UX pass: a drag reorder sends the SAME blocks (ids kept) in another order
        moved = self.save_blocks(page, [blocks[1], blocks[2], blocks[0]])
        self.assertEqual(moved["rev"], page["rev"] + 1, "one reorder = one revision")
        self.assertEqual([b["id"] for b in moved["content"]["blocks"]], [ids[1], ids[2], ids[0]])
        self.assertEqual(moved["content"]["blocks"][2]["asset"]["layout"], "center")
        # persisted bytes: exactly the declared keys, no position/CSS state
        stored = json.loads(self.path.read_text(encoding="utf-8"))
        for blk in stored["pages"][-1]["content"]["blocks"]:
            if blk["type"] == "image":
                self.assertEqual(set(blk["asset"]), {"id", "mime", "w", "h", "width", "layout", "caption"})
        # an old-client style payload (layout "inline") is untouched by this change
        again = self.save_blocks(moved, [image_block(a, layout="inline", block_id=ids[0])])
        self.assertEqual(again["content"]["blocks"][0]["asset"]["layout"], "inline")

    def test_binary_absent_from_notebook_json_and_no_paths(self):
        page = self.new_page()
        data = F.jpeg(64, 48)
        asset = upload(data)
        page = self.save_blocks(page, [para("intro"), image_block(asset, caption="Vue de face"), para("fin")])
        raw = self.path.read_bytes()
        self.assertNotIn(data[:16], raw)
        self.assertNotIn(b"\xff\xd8", raw)
        text = raw.decode("utf-8")
        self.assertNotIn(str(self.tmp), text)
        self.assertNotIn(".hq-carnet/assets", text)
        self.assertNotIn("base64", text)
        stored = self.disk()["pages"][-1]["content"]["blocks"][1]
        self.assertEqual(set(stored), {"id", "type", "text", "marks", "asset"})
        self.assertEqual(stored["asset"], {"id": asset["id"], "mime": "image/jpeg", "w": 64, "h": 48, "width": 60, "layout": "inline", "caption": "Vue de face"})
        self.assertLess(len(json.dumps(stored)), 400)
        self.assertEqual(page["content"]["blocks"][1]["id"], stored["id"])

    def test_save_rejects_unknown_or_inconsistent_assets(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        ghost = dict(asset, id="asset-" + "e" * 24)
        for bad, frag in (
            (ghost, "inconnue"),
            (dict(asset, w=11), "incohérentes"),
            (dict(asset, h=9), "incohérentes"),
            (dict(asset, mime="image/jpeg"), "incohérentes"),
        ):
            with self.assertRaises(hq_carnet.CarnetError) as cm:
                self.save_blocks(page, [image_block(bad)])
            self.assertIn(frag, str(cm.exception))
            self.assertNotIn(str(self.tmp), str(cm.exception))
        self.assertEqual(self.disk()["pages"][-1]["rev"], page["rev"])

    def test_schema_bounds(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        ok = image_block(asset)

        def asset_with(**kw):
            blk = json.loads(json.dumps(ok))
            blk["asset"].update(kw)
            return blk

        bad = [
            asset_with(width=29), asset_with(width=101), asset_with(width=50.5), asset_with(width=True), asset_with(layout="free"),
            asset_with(layout="left"), asset_with(layout="CENTER"), asset_with(layout=True), asset_with(layout=1), asset_with(layout=None), asset_with(layout=["center"]),
            asset_with(caption="a" * 301), asset_with(caption="two\nlines"), asset_with(caption=5), asset_with(w=0), asset_with(w=2561),
            asset_with(id="asset-../x"), asset_with(mime="image/gif"),
            {**ok, "text": "caption here"}, {**ok, "marks": [{"type": "bold", "start": 0, "end": 1}]}, {**ok, "checked": True},
            {k: v for k, v in ok.items() if k != "asset"},
            {**ok, "asset": {**ok["asset"], "path": "/etc/passwd"}},
            {**ok, "asset": {k: v for k, v in ok["asset"].items() if k != "caption"}},
            {"type": "paragraph", "text": "x", "marks": [], "asset": ok["asset"]},
        ]
        for blk in bad:
            with self.assertRaises(hq_carnet.CarnetError, msg=json.dumps(blk)[:120]):
                self.save_blocks(page, [blk])
        # UX pass: the bounded alignments are accepted and round-trip exactly (never normalised back to inline).
        for layout in ("inline", "center", "right"):
            page = self.save_blocks(page, [asset_with(layout=layout)])
            self.assertEqual(page["content"]["blocks"][0]["asset"]["layout"], layout)
        for width in (30, 100):  # boundaries are accepted
            page = self.save_blocks(page, [image_block(asset, width=width)])
        self.assertEqual(rich.assets_of(page["content"])[0]["width"], 100)

    def test_images_per_page_bound(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        blocks = [image_block(asset) for _ in range(media.IMAGES_PER_PAGE_MAX)]
        page = self.save_blocks(page, blocks)
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_blocks(page, blocks + [image_block(asset)])

    def test_caption_add_edit_remove_and_width_persist_with_block_identity(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        page = self.save_blocks(page, [para("a"), image_block(asset)])
        bid = page["content"]["blocks"][1]["id"]
        for caption, width in (("légende", 45), ("légende 2", 45), ("", 80)):
            blocks = json.loads(json.dumps(page["content"]["blocks"]))
            blocks[1]["asset"].update(caption=caption, width=width)
            page = self.save_blocks(page, blocks)
            stored = page["content"]["blocks"][1]
            self.assertEqual((stored["id"], stored["asset"]["caption"], stored["asset"]["width"]), (bid, caption, width))
        self.assertEqual(page["rev"], 5)

    def test_text_only_v2_pages_stay_canonical_and_byte_compatible(self):
        page = self.new_page()
        blocks = [
            {"type": "heading", "text": "Titre", "marks": [{"type": "bold", "start": 0, "end": 5}]},
            {"type": "check", "text": "todo", "marks": [], "checked": True},
            para("texte", marks=[{"type": "link", "start": 0, "end": 5, "href": "https://example.test/x"}]),
        ]
        page = self.save_blocks(page, blocks)
        stored = self.disk()["pages"][-1]["content"]
        for block in stored["blocks"]:
            self.assertNotIn("asset", block)
            self.assertEqual(set(block), {"id", "type", "text", "marks"} | ({"checked"} if block["type"] == "check" else set()))
        self.assertTrue(rich.valid_v2(stored))
        # an 'asset' key on a text block is a schema violation, both on write and on stored state
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_blocks(page, [dict(blocks[0], asset={"id": "x"})])
        tampered = json.loads(json.dumps(stored))
        tampered["blocks"][0]["asset"] = {"id": "asset-" + "a" * 24}
        self.assertFalse(rich.valid_v2(tampered))
        # Stage-05 shaped content (no image) saves/reads exactly as before: same canonical output
        again = self.save_blocks(page, [dict(b, id=b["id"]) for b in stored["blocks"]])
        self.assertEqual(again["rev"], page["rev"], "re-saving identical text-only content is a no-op")

    def test_stored_image_block_validity(self):
        asset = {"id": "asset-" + "a" * 24, "mime": "image/png", "w": 5, "h": 5, "width": 50, "layout": "inline", "caption": ""}
        good = {"version": 2, "blocks": [{"id": "block-i", "type": "image", "text": "", "marks": [], "asset": asset}]}
        self.assertTrue(rich.valid_v2(good))
        for mutate in (lambda c: c["blocks"][0].update(text="x"), lambda c: c["blocks"][0]["asset"].update(width=5),
                       lambda c: c["blocks"][0].pop("asset"), lambda c: c["blocks"][0]["asset"].update(extra=1),
                       lambda c: c["blocks"][0].update(checked=False)):
            bad = json.loads(json.dumps(good))
            mutate(bad)
            self.assertFalse(rich.valid_v2(bad))

    def test_existing_reference_to_missing_file_is_preserved_not_blocking(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        page = self.save_blocks(page, [para("a"), image_block(asset)])
        (self.adir / (asset["id"] + ".png")).unlink()  # state damaged outside Carnet
        blocks = json.loads(json.dumps(page["content"]["blocks"]))
        blocks[0]["text"] = "edited"
        page = self.save_blocks(page, blocks)  # unrelated edit still works; the reference is preserved
        self.assertEqual(rich.assets_of(page["content"])[0]["id"], asset["id"])
        blocks = json.loads(json.dumps(page["content"]["blocks"]))
        blocks[1]["asset"]["caption"] = "caption on a missing file"  # same file identity: still not re-verified
        self.save_blocks(page, blocks)

    def test_replacing_the_asset_of_a_block_verifies_the_new_file(self):
        page = self.new_page()
        a1, a2 = upload(F.png(10, 8)), upload(F.jpeg(12, 12))
        page = self.save_blocks(page, [image_block(a1)])
        blocks = json.loads(json.dumps(page["content"]["blocks"]))
        blocks[0]["asset"].update(id=a2["id"], mime=a2["mime"], w=a2["w"], h=a2["h"])
        page = self.save_blocks(page, blocks)
        self.assertEqual(rich.assets_of(page["content"])[0]["id"], a2["id"])
        self.assertEqual(len(self.files()), 2, "the replaced asset stays on disk (orphan, counted by the quota)")
        blocks[0]["asset"]["id"] = "asset-" + "9" * 24
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_blocks(page, blocks)

    def test_stale_revision_rejects_image_edit(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        page = self.save_blocks(page, [para("a"), image_block(asset)])
        stale_rev = page["rev"]
        blocks = json.loads(json.dumps(page["content"]["blocks"]))
        blocks[1]["asset"]["width"] = 40
        page = self.save_blocks(page, blocks)  # the other client changes the width
        blocks2 = json.loads(json.dumps(blocks))
        blocks2[1]["asset"]["caption"] = "mine"
        with self.assertRaises(hq_carnet.CarnetConflict) as cm:
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": stale_rev, "content": {"version": 2, "blocks": blocks2}})
        self.assertEqual(cm.exception.payload["code"], "revision_conflict")
        self.assertEqual(rich.assets_of(cm.exception.payload["page"]["content"])[0]["width"], 40)

    def test_legacy_v1_page_can_gain_an_image(self):
        page = self.new_page()
        legacy = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"],
                                   "content": {"version": 1, "blocks": [{"type": "text", "text": "a\nb", "marks": []}]}})["page"]
        asset = upload(F.png(10, 8))
        page = self.save_blocks(legacy, [para("a"), image_block(asset), para("b")])
        self.assertEqual(page["content"]["version"], 2)
        self.assertEqual(rich.flat_text(page["content"]), "a\n\nb")

    def test_image_block_is_inert_to_text_search_and_title(self):
        page = self.new_page()
        asset = upload(F.png(10, 8))
        page = self.save_blocks(page, [image_block(asset, caption="secret caption"), para("Titre réel")])
        meta = hq_carnet.get_notebook(meta=True)["pages"][-1]
        self.assertEqual(meta["title"], "Titre réel")
        self.assertNotIn("secret caption", json.dumps(meta))

    def test_reference_check_reads_only_the_header(self):
        # a save re-checks metadata from the header of a write-once file; it never re-reads megabytes under the notebook lock
        page = self.new_page()
        asset = upload(F.png(10, 8))
        path = self.adir / (asset["id"] + ".png")
        reads = []

        class Spy:
            def __init__(self, handle):
                self.handle = handle

            def read(self, n=-1):
                reads.append(n)
                return self.handle.read(n)

            def __getattr__(self, name):
                return getattr(self.handle, name)

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                self.handle.close()

        real_open = media.open_asset

        def spy_open(asset_id, root=None):
            handle, mime, size = real_open(asset_id, root)
            return Spy(handle), mime, size

        big = F.png_of_size(6 * MIB, 640, 480)  # structurally valid (CRC ok) 6 MiB file
        path.write_bytes(big)
        with mock.patch.object(media, "open_asset", spy_open):
            page = self.save_blocks(page, [image_block(dict(asset, w=640, h=480))])
        self.assertLess(sum(n for n in reads if n > 0), 64 * 1024, reads)
        self.assertEqual(rich.assets_of(page["content"])[0]["w"], 640)

    def test_limits_expose_media_bounds(self):
        limits = hq_carnet.get_notebook()["limits"]
        self.assertEqual((limits["media_file_bytes"], limits["media_total_bytes"], limits["media_long_side"]), (12 * MIB, 250 * MIB, 2560))
        self.assertEqual(limits["media_source_bytes"], 16 * MIB)
        self.assertEqual(limits["media_mimes"], ["image/jpeg", "image/png", "image/webp"])
        self.assertEqual(limits["page_text_bytes"], 49152)


# ---------------------------------------------------------------- export


class AlignedExportTests(MediaBase):
    """Markdown/TXT have no alignment: center/right use the SAME deterministic text as inline (documented fallback)."""

    def test_markdown_and_txt_are_layout_independent_and_deterministic(self):
        a = upload(F.png(10, 8))
        page = self.new_page()
        outputs = {}
        for layout in ("inline", "center", "right"):
            content = {"version": 2, "blocks": [para("avant"), image_block(a, layout=layout, caption="Fig. 1", width=50), para("après")]}
            parsed = rich.parse_content(content, existing=None, text_limit=10_000)
            blocks = [{**b, "id": f"block-{i:012d}"} for i, b in enumerate(parsed["blocks"])]
            doc = {"version": 2, "blocks": blocks}
            paths = {a["id"]: "note.assets/figure-01.png"}
            outputs[layout] = (rich.render_markdown(doc, paths), rich.render_txt(doc), rich.render_markdown(doc, paths))
            self.assertEqual(outputs[layout][0], outputs[layout][2], "deterministic")
        self.assertEqual(outputs["inline"], outputs["center"])
        self.assertEqual(outputs["inline"], outputs["right"])
        self.assertIn("![Fig. 1](note.assets/figure-01.png)", outputs["right"][0])
        self.assertNotRegex(outputs["right"][0], r"(?i)center|right|align|style=|<div")

    def test_package_export_with_a_right_aligned_image(self):
        a = upload(F.png(10, 8))
        page = self.save_blocks(self.new_page(), [para("t"), image_block(a, layout="right", caption="c")])
        out = hq_carnet.export_copy({"action": "page_export", "id": page["id"], "expected_rev": page["rev"], "format": "md", "dir": "Inbox", "filename": "al"})
        md = (self.tmp / "Inbox" / "al.md").read_text(encoding="utf-8")
        self.assertIn("![c](al.assets/figure-01.png)", md)
        self.assertNotIn(str(self.tmp), md)
        self.assertEqual(out["assets"], 1)


class ExportTests(MediaBase):
    def setUp(self):
        super().setUp()
        self.page = self.new_page()
        self.a1 = upload(F.png(10, 8))
        self.a2 = upload(F.jpeg(16, 12))
        self.page = self.save_blocks(self.page, [
            para("Titre de note"), image_block(self.a1, caption="Vue [A] (1)"), para("milieu"),
            image_block(self.a2), image_block(self.a1, caption="encore"),
        ])

    def export(self, fmt="md", **kw):
        return hq_carnet.export_copy({"action": "page_export", "id": self.page["id"], "expected_rev": self.page["rev"],
                                      "format": fmt, "dir": "Inbox", **kw})

    def test_markdown_package_uses_relative_assets(self):
        out = self.export("md", filename="note")
        self.assertEqual((out["path"], out["assets_dir"], out["assets"]), ("Inbox/note.md", "Inbox/note.assets", 2))
        md = (self.tmp / "Inbox" / "note.md").read_text(encoding="utf-8")
        self.assertIn("![Vue \\[A\\] (1)](note.assets/figure-01.png)", md)
        self.assertIn("![](note.assets/figure-02.jpg)", md)
        self.assertIn("![encore](note.assets/figure-01.png)", md)  # same asset reused, one packaged copy
        self.assertIn("*Vue \\[A\\] (1)*", md)
        self.assertNotIn(str(self.tmp), md)
        self.assertNotIn(".hq-carnet", md)
        self.assertNotRegex(md, r"\]\((/|[A-Za-z]:|\\|file:)")
        pkg = self.tmp / "Inbox" / "note.assets"
        self.assertEqual(sorted(os.listdir(pkg)), ["figure-01.png", "figure-02.jpg"])
        self.assertEqual((pkg / "figure-01.png").read_bytes(), F.png(10, 8))
        self.assertEqual((pkg / "figure-02.jpg").read_bytes(), F.jpeg(16, 12))

    def test_package_name_with_special_characters_is_percent_encoded(self):
        out = self.export("md", filename="Rapport #1 é?x")
        stem = out["assets_dir"].split("/")[-1]
        self.assertTrue((self.tmp / "Inbox" / stem / "figure-01.png").is_file())
        md = (self.tmp / "Inbox" / out["name"]).read_text(encoding="utf-8")
        self.assertIn("(Rapport%20%231%20%C3%A9-x.assets/figure-01.png)", md)
        self.assertNotRegex(md, r"\]\([^)]*[# ?]")

    def test_txt_has_caption_labels_and_no_binary(self):
        out = self.export("txt", filename="note")
        self.assertNotIn("assets_dir", out)
        txt = (self.tmp / "Inbox" / "note.txt").read_text(encoding="utf-8")
        self.assertEqual(txt, "Titre de note\n[Image : Vue [A] (1)]\nmilieu\n[Image]\n[Image : encore]\n")
        self.assertEqual(os.listdir(self.tmp / "Inbox"), ["note.txt"])

    def test_noclobber_and_no_partial_package(self):
        self.export("md", filename="note")
        with self.assertRaises(hq_carnet.CarnetConflict):
            self.export("md", filename="note")
        (self.tmp / "Inbox" / "other.assets").mkdir()
        with self.assertRaises(hq_carnet.CarnetConflict):
            self.export("md", filename="other")
        self.assertEqual(os.listdir(self.tmp / "Inbox" / "other.assets"), [])
        self.assertFalse((self.tmp / "Inbox" / "other.md").exists())

    def test_missing_asset_fails_closed_and_cleans_up(self):
        (self.adir / (self.a2["id"] + ".jpg")).unlink()
        with self.assertRaises(hq_carnet.CarnetError) as cm:
            self.export("md", filename="broken")
        self.assertNotIn(str(self.tmp), str(cm.exception))
        self.assertEqual(os.listdir(self.tmp / "Inbox"), [], "no .md, no package directory, no stray figure left behind")

    def test_target_created_concurrently_keeps_foreign_file_and_removes_our_package(self):
        real_open = open

        def racing_open(file, mode="r", *a, **k):
            if str(file).endswith("race.md") and "x" in mode:
                with real_open(file, "wb") as other:
                    other.write(b"foreign")  # someone else wins the race
            return real_open(file, mode, *a, **k)

        with mock.patch("builtins.open", racing_open):
            with self.assertRaises(hq_carnet.CarnetConflict):
                self.export("md", filename="race")
        self.assertEqual((self.tmp / "Inbox" / "race.md").read_bytes(), b"foreign")
        self.assertFalse((self.tmp / "Inbox" / "race.assets").exists())

    def test_text_only_markdown_export_is_unchanged(self):
        page = self.new_page()
        page = self.save_blocks(page, [para("juste du texte")])
        out = hq_carnet.export_copy({"action": "page_export", "id": page["id"], "expected_rev": page["rev"], "format": "md", "dir": "Inbox", "filename": "plain"})
        self.assertNotIn("assets_dir", out)
        self.assertEqual((self.tmp / "Inbox" / "plain.md").read_text(encoding="utf-8"), "juste du texte\n")
        self.assertFalse((self.tmp / "Inbox" / "plain.assets").exists())

    def test_render_without_package_paths_never_links(self):
        md = rich.render_markdown(self.page["content"])
        self.assertNotRegex(md, r"!\[")
        self.assertIn("\\[Image", md)


# ---------------------------------------------------------------- backup


class AlignedHistoryBulkTests(Stage08Base):
    """UX pass: history restore / bulk operations / report keep an aligned image exactly (layout + width + order)."""

    def setUp(self):
        super().setUp()
        saved = dict(media._cb)
        self.addCleanup(lambda: (media._cb.clear(), media._cb.update(saved)))
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        self.asset = upload(F.png(10, 8))

    def blocks(self, layout="center", width=70):
        return [para("avant avec alpha"), image_block(self.asset, layout=layout, width=width, caption="Fig"), para("apres")]

    def test_restore_returns_the_exact_aligned_image_and_order(self):
        page = self.make_page(self.blocks("center", 70))
        want = [(b["id"], b["type"], b.get("asset")) for b in page["content"]["blocks"]]
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        edited_blocks = [dict(b) for b in page["content"]["blocks"]]
        edited_blocks[1] = {**edited_blocks[1], "asset": {**edited_blocks[1]["asset"], "layout": "right", "width": 40}}
        edited_blocks = [edited_blocks[1], edited_blocks[0], edited_blocks[2]]  # also moved
        edited = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": edited_blocks}})["page"]
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": edited["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        got = [(b["id"], b["type"], b.get("asset")) for b in self.cur(page["id"])["content"]["blocks"]]
        self.assertEqual(got, want)

    def test_bulk_replace_leaves_an_aligned_image_block_untouched(self):
        page = self.make_page(self.blocks("right", 55))
        pv = self.preview("replace", {"find": "alpha", "replace": "OMEGA"}, [page["id"]])
        out = self.apply("replace", pv["params"], [{"id": page["id"], "rev": page["rev"]}], expected=1)
        self.assertEqual(out["outcome"], "complete", out)
        blocks = self.cur(page["id"])["content"]["blocks"]
        self.assertEqual(blocks[0]["text"], "avant avec OMEGA")
        self.assertEqual(blocks[1]["asset"]["layout"], "right")
        self.assertEqual(blocks[1]["asset"]["width"], 55)
        undo = self.undo(out["event_id"])
        self.assertTrue(undo.get("ok"), undo)
        blocks = self.cur(page["id"])["content"]["blocks"]
        self.assertEqual((blocks[0]["text"], blocks[1]["asset"]["layout"]), ("avant avec alpha", "right"))


class BackupMediaTests(_retention.RetentionBase):
    def setUp(self):
        super().setUp()
        saved, saved_ready = dict(hq_carnet._cb), hq_carnet._ready
        saved_media = dict(media._cb)

        def restore():
            hq_carnet._cb.clear()
            hq_carnet._cb.update(saved)
            hq_carnet._ready = saved_ready
            media._cb.clear()
            media._cb.update(saved_media)

        self.addCleanup(restore)
        hq_carnet.bind(root=self.root, now=lambda: NOW, folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        self.adir = self.root / ".hq-carnet" / "assets"
        self.nb = self.root / ".hq-carnet" / "notebook.json"

    def page_with(self, *assets) -> dict:
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
        blocks = [image_block(a) for a in assets] or [para("x")]
        return hq_carnet.mutate({"action": "page_save", "id": nb["id"], "expected_rev": nb["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def backup(self) -> tuple[dict, Path]:
        info = cc_ext.run_backup(force=True)
        return info, Path(info["path"]) / "Carnet"

    def test_backup_keeps_a_non_default_layout_and_its_asset(self):
        a1 = upload(F.png(9, 9))
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
        hq_carnet.mutate({"action": "page_save", "id": nb["id"], "expected_rev": nb["rev"],
                          "content": {"version": 2, "blocks": [image_block(a1, layout="center", width=65, caption="Fig")]}})
        info, dest = self.backup()
        self.assertTrue(info["carnet"]["valid"])
        saved = json.loads((dest / "notebook.json").read_text(encoding="utf-8"))
        asset = [b for p in saved["pages"] for b in p["content"]["blocks"] if b["type"] == "image"][0]["asset"]
        self.assertEqual((asset["layout"], asset["width"]), ("center", 65))
        self.assertEqual((dest / "assets" / (a1["id"] + ".png")).read_bytes(), F.png(9, 9))

    def test_no_assets_keeps_the_accepted_status_shape(self):
        self.page_with()
        info, dest = self.backup()
        self.assertEqual(set(info["carnet"]), {"ok", "included", "status", "bytes", "valid"})
        self.assertEqual(os.listdir(dest), ["notebook.json"])

    def test_referenced_assets_are_copied_and_nothing_else(self):
        a1, a2, orphan = upload(F.png(9, 9)), upload(F.jpeg(10, 10)), upload(F.webp_vp8l())
        self.page_with(a1)
        self.page_with(a1, a2)  # two pages reference a1
        (self.adir / ".tmp-partial").write_bytes(b"partial")
        (self.adir / "readme.txt").write_text("unrelated", encoding="utf-8")
        info, dest = self.backup()
        self.assertEqual(info["carnet"]["assets"], {"count": 2, "bytes": len(F.png(9, 9)) + len(F.jpeg(10, 10)), "missing": 0})
        self.assertTrue(info["carnet"]["valid"])
        self.assertEqual(sorted(os.listdir(dest / "assets")), sorted([a1["id"] + ".png", a2["id"] + ".jpg"]))
        self.assertEqual((dest / "assets" / (a1["id"] + ".png")).read_bytes(), F.png(9, 9))
        self.assertFalse((dest / "assets" / (orphan["id"] + ".webp")).exists(), "unreferenced orphans are not part of the snapshot")
        self.assertNotIn(str(self.root), json.dumps(info["carnet"]))
        self.assertTrue((self.adir / ".tmp-partial").exists() and (self.adir / "readme.txt").exists())  # source untouched

    def test_trashed_page_assets_are_still_referenced(self):
        a1 = upload(F.png(9, 9))
        page = self.page_with(a1)
        hq_carnet.mutate({"action": "page_trash", "id": page["id"], "expected_rev": page["rev"],
                          "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})
        info, dest = self.backup()
        self.assertEqual(info["carnet"]["assets"]["count"], 1)

    def test_missing_referenced_asset_marks_invalid_and_blocks_purge(self):
        a1, a2 = upload(F.png(9, 9)), upload(F.jpeg(10, 10))
        self.page_with(a1, a2)
        (self.adir / (a2["id"] + ".jpg")).unlink()
        info, dest = self.backup()
        self.assertEqual(info["carnet"]["assets"], {"count": 1, "bytes": len(F.png(9, 9)), "missing": 1})
        self.assertFalse(info["carnet"]["valid"])
        self.assertEqual(info["purge"]["reason"], "carnet_invalid")
        self.assertEqual(sorted(os.listdir(dest)), ["assets", "notebook.json"])

    def test_malformed_asset_metadata_fails_closed(self):
        a1 = upload(F.png(9, 9))
        self.page_with(a1)
        state = json.loads(self.nb.read_text(encoding="utf-8"))
        state["pages"][-1]["content"]["blocks"][0]["asset"]["id"] = "../../etc/passwd"
        payload = json.dumps(state).encode()
        self.nb.write_bytes(payload)
        info, dest = self.backup()
        self.assertFalse(info["carnet"]["valid"])
        self.assertNotIn("assets", info["carnet"])
        self.assertEqual((dest / "notebook.json").read_bytes(), payload, "malformed bytes are copied untouched")
        self.assertFalse((dest / "assets").exists())
        self.assertEqual(info["purge"]["reason"], "carnet_invalid")

    def test_symlink_inside_asset_dir_is_not_followed(self):
        a1 = upload(F.png(9, 9))
        self.page_with(a1)
        outside = self.root / "outside.png"
        outside.write_bytes(F.png(3, 3))
        final = self.adir / (a1["id"] + ".png")
        final.unlink()
        _file_symlink(outside, final)
        info, dest = self.backup()
        self.assertEqual(info["carnet"]["assets"]["missing"], 1)
        self.assertFalse(info["carnet"]["valid"])
        self.assertFalse((dest / "assets" / final.name).exists())

    def test_symlinked_asset_directory_fails_the_carnet_snapshot_closed(self):
        a1 = upload(F.png(9, 9))
        self.page_with(a1)
        moved = self.root / "moved-assets"
        self.adir.rename(moved)
        _dir_symlink(moved, self.adir)
        info, _dest = self.backup()
        self.assertEqual((info["carnet"]["ok"], info["carnet"]["status"]), (False, "failed"))
        self.assertNotIn(str(self.root), json.dumps(info["carnet"]))
        self.assertEqual(info["folders"], 1)  # the legacy backup still ran
        self.assertEqual(info["purge"]["reason"], "carnet_snapshot_failed")

    def test_asset_added_during_backup_is_not_in_the_snapshot(self):
        a1 = upload(F.png(9, 9))
        self.page_with(a1)
        real = media.copy_assets_to
        late = {}

        def copy_and_add(root, ids, dest):
            out = real(root, ids, dest)
            late.update(upload(F.png(7, 7)))  # uploaded while the copy is running (assets lock is reentrant here)
            return out

        with mock.patch.object(media, "copy_assets_to", side_effect=copy_and_add):
            info, dest = self.backup()
        self.assertEqual(os.listdir(dest / "assets"), [a1["id"] + ".png"])
        self.assertTrue(info["carnet"]["valid"])

    def test_upload_waits_while_backup_holds_the_assets_lock(self):
        a1 = upload(F.png(9, 9))
        self.page_with(a1)
        entered, release = threading.Event(), threading.Event()
        real = media.copy_assets_to

        def slow_copy(root, ids, dest):
            entered.set()
            release.wait(10)
            return real(root, ids, dest)

        result = {}
        with mock.patch.object(media, "copy_assets_to", side_effect=slow_copy):
            t = threading.Thread(target=lambda: result.update(cc_ext.run_backup(force=True)))
            t.start()
            self.assertTrue(entered.wait(10))
            up = threading.Thread(target=lambda: result.__setitem__("late", upload(F.png(7, 7))))
            up.start()
            time.sleep(0.3)
            self.assertTrue(up.is_alive(), "finalisation waits for the assets lock")
            release.set()
            t.join(10)
            up.join(10)
        self.assertEqual(Path(result["path"]).joinpath("Carnet", "assets").iterdir().__next__().name, a1["id"] + ".png")

    def test_asset_replaced_during_backup_keeps_snapshot_coherent(self):
        a1 = upload(F.png(9, 9))
        page = self.page_with(a1)
        real = hq_carnet.referenced_assets
        a2 = upload(F.jpeg(10, 10))

        def replace_after_read(state):
            out = real(state)
            blocks = [image_block(a2)]  # another client swaps the image right after the notebook was read
            hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": blocks}})
            return out

        with mock.patch.object(hq_carnet, "referenced_assets", side_effect=replace_after_read):
            info, dest = self.backup()
        snap = json.loads((dest / "notebook.json").read_text(encoding="utf-8"))
        self.assertEqual(rich.assets_of(snap["pages"][-1]["content"])[0]["id"], a1["id"])
        self.assertEqual(os.listdir(dest / "assets"), [a1["id"] + ".png"])  # notebook and assets agree
        self.assertTrue(info["carnet"]["valid"])


# ---------------------------------------------------------------- HTTP (auth, CSRF, headers, streaming)


class MediaApiTests(_ApiBase):
    """Reuses the throwaway loopback server of the Stage-01 API tests (temp ROOT, fake PINs)."""

    # Inherit only the fixture; do not re-run the parent's test methods under this class.
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.adir = cls.tmp / ".hq-carnet" / "assets"

    def setUp(self):
        super().setUp()
        if self.adir.exists():
            for name in os.listdir(self.adir):
                (self.adir / name).unlink()

    def up(self, data, *, cookie=None, mime=None, origin=True, headers=None):
        hdrs = {"Content-Type": "application/octet-stream"}
        if origin:
            hdrs["Origin"] = f"http://127.0.0.1:{self.port}"
        if mime:
            hdrs["X-Carnet-Mime"] = mime
        hdrs.update(headers or {})
        return _http(self.port, "POST", "/api/carnet/asset", body=data, headers=hdrs, cookie=self.admin if cookie is None else cookie)

    def test_admin_upload_roundtrip_and_serving_headers(self):
        data = F.png(14, 9)
        status, _h, body = self.up(data, mime="image/png")
        self.assertEqual(status, 200, body)
        asset = json.loads(body)["asset"]
        self.assertEqual((asset["mime"], asset["w"], asset["h"], asset["bytes"]), ("image/png", 14, 9, len(data)))
        self.assertNotIn(str(self.tmp).encode(), body)
        status, headers, served = self._get("/api/carnet/asset/" + asset["id"])
        self.assertEqual((status, served), (200, data))
        low = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(low["content-type"], "image/png")
        self.assertEqual(low["x-content-type-options"], "nosniff")
        self.assertEqual(low["x-frame-options"], "DENY")
        self.assertEqual(low["cache-control"], "private, no-cache")  # revalidated on every use: auth is re-checked
        self.assertEqual(low["etag"], '"' + asset["id"] + '"')
        self.assertIn("frame-ancestors 'none'", low["content-security-policy"])
        self.assertNotIn("filename", low.get("content-disposition", ""))
        status, headers, empty = _http(self.port, "GET", "/api/carnet/asset/" + asset["id"], headers={"If-None-Match": '"' + asset["id"] + '"'}, cookie=self.admin)
        self.assertEqual((status, empty), (304, b""))  # an unchanged image costs a 304...
        self.assertEqual(_http(self.port, "GET", "/api/carnet/asset/" + asset["id"], headers={"If-None-Match": '"' + asset["id"] + '"'}, cookie="")[0], 401)  # ...but never skips auth
        self.assertEqual(_http(self.port, "GET", "/api/carnet/asset/" + asset["id"], headers={"If-None-Match": '"' + asset["id"] + '"'}, cookie=self.upload)[0], 403)
        status, _h, body = self._get("/api/carnet/asset")
        usage = json.loads(body)
        self.assertEqual((status, usage["files"], usage["max_bytes"]), (200, 1, 250 * MIB))

    def test_auth_role_and_csrf(self):
        data = F.png()
        self.assertEqual(self.up(data, cookie="")[0], 401)
        self.assertEqual(self.up(data, cookie=self.upload)[0], 403)
        status, _h, body = self.up(data, origin=False)
        self.assertEqual(status, 403)
        self.assertIn(b"CSRF", body)
        status, _h, _b = self.up(data, headers={"Origin": "http://evil.example"})
        self.assertEqual(status, 403)
        self.assertEqual(os.listdir(self.adir) if self.adir.exists() else [], [])
        ok = json.loads(self.up(data)[2])["asset"]
        self.assertEqual(_http(self.port, "GET", "/api/carnet/asset/" + ok["id"], cookie="")[0], 401)
        self.assertEqual(self._get("/api/carnet/asset/" + ok["id"], cookie=self.upload)[0], 403)
        self.assertEqual(self._get("/api/carnet/asset", cookie=self.upload)[0], 403)
        for route in ("/api/carnet/asset", "/api/carnet/asset/x"):
            self.assertFalse(any(route.startswith(p) for p in iphone_bridge.UPLOAD_GET_PREFIX))
            self.assertNotIn(route, iphone_bridge.UPLOAD_POST_EXACT)

    def test_spoofed_types_and_bad_bodies_over_http(self):
        self.assertEqual(self.up(F.png(), mime="image/jpeg")[0], 415)
        self.assertEqual(self.up(b"<html><script>alert(1)</script></html>", mime="image/png")[0], 415)
        self.assertEqual(self.up(F.png(20, 20, truncate=3))[0], 400)
        status, _h, body = self.up(F.jpeg(16, 8, orientation=6))
        self.assertEqual((status, json.loads(body)["code"]), (415, "exif_orientation"))
        self.assertEqual(self.up(F.png(2561, 4))[0], 413)
        self.assertEqual(self.up(b"")[0], 400)
        self.assertEqual(os.listdir(self.adir) if self.adir.exists() else [], [])

    def raw(self, request: bytes, *, body_after: bytes = b"", close_write: bool = False, read_timeout=5.0) -> tuple[int, bytes]:
        s = socket.create_connection(("127.0.0.1", self.port), timeout=read_timeout)
        s.sendall(request + body_after)
        if close_write:
            s.shutdown(socket.SHUT_WR)
        buf = b""
        try:
            while b"\r\n\r\n" not in buf:
                chunk = s.recv(4096)
                if not chunk:
                    break
                buf += chunk
        finally:
            s.close()
        status = int(buf.split(b" ", 2)[1]) if buf else 0
        return status, buf

    def req(self, length: int | None, extra: str = "") -> bytes:
        lines = [f"POST /api/carnet/asset HTTP/1.1", f"Host: 127.0.0.1:{self.port}", f"Origin: http://127.0.0.1:{self.port}",
                 f"Cookie: {self.admin}", "Content-Type: application/octet-stream"]
        if length is not None:
            lines.append(f"Content-Length: {length}")
        return ("\r\n".join(lines) + "\r\n" + extra + "\r\n").encode()

    def test_oversize_content_length_refused_before_any_body(self):
        status, _buf = self.raw(self.req(media.MAX_FILE_BYTES + 1))  # no body is ever sent: refused from headers alone
        self.assertEqual(status, 413)
        status, _buf = self.raw(self.req(None))
        self.assertEqual(status, 400)
        self.assertEqual(os.listdir(self.adir) if self.adir.exists() else [], [])

    def test_chunked_transfer_is_refused(self):
        status, _buf = self.raw(self.req(None, "Transfer-Encoding: chunked\r\n"), body_after=b"5\r\nhello\r\n0\r\n\r\n")
        self.assertEqual(status, 411)

    def test_interrupted_upload_over_http_leaves_no_residue(self):
        data = F.png(30, 30)
        done = threading.Event()
        real = media.store_upload

        def watched(*a, **k):
            try:
                return real(*a, **k)
            finally:
                done.set()

        with mock.patch.object(media, "store_upload", watched):
            s = socket.create_connection(("127.0.0.1", self.port), timeout=5)
            s.sendall(self.req(len(data)) + data[: len(data) // 2])
            s.close()  # client vanishes mid-body
            self.assertTrue(done.wait(15), "the server must notice the dead connection and finish the upload attempt")
        self.assertEqual(os.listdir(self.adir) if self.adir.exists() else [], [])
        self.assertEqual(media._reserved, {})
        self.assertEqual(self.up(data)[0], 200)  # the slot was released

    def test_served_asset_404s_and_no_path_in_errors(self):
        for trick in ("../secret", "..%2fsecret", "%2e%2e/%2e%2e/etc/passwd", "asset-" + "0" * 24, "C%3A%5CWindows", "a" * 300):
            status, _h, body = self._get("/api/carnet/asset/" + trick)
            self.assertIn(status, (400, 404), trick)
            self.assertNotIn(str(self.tmp).encode(), body)

    def test_double_click_double_submit_over_http(self):
        data = F.png(10, 10)
        results = []
        barrier = threading.Barrier(2)

        def go():
            barrier.wait()
            results.append(self.up(data)[0])

        threads = [threading.Thread(target=go) for _ in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(15)
        self.assertEqual(sorted(results), [200, 200])
        self.assertEqual(len(os.listdir(self.adir)), 2)

    def test_page_save_over_http_with_image_and_notebook_has_no_binary(self):
        data = F.jpeg(40, 30)
        asset = json.loads(self.up(data)[2])["asset"]
        content = {"version": 2, "blocks": [para("t"), image_block(asset, caption="c")]}
        status, _h, body = self._post({"action": "page_save", "id": "page-shaft", "expected_rev": 3, "content": content})
        self.assertEqual(status, 200, body)
        raw = self.path.read_bytes()
        self.assertNotIn(b"\xff\xd8", raw)
        self.assertNotIn(str(self.tmp).encode(), raw)
        # the upload role cannot save images either (unchanged admin-only contract)
        self.assertEqual(self._post({"action": "page_save", "id": "page-shaft", "expected_rev": 4, "content": content}, cookie=self.upload)[0], 403)


class MediaHttpSpoofTests(MediaApiTests):
    """(Runs only its own tests: the parent's are blanked below.)"""

    def test_request_content_type_and_file_name_hints_are_ignored(self):
        data = F.jpeg(20, 10)
        # Content-Type says PNG, a Content-Disposition names a path: neither is read; the bytes decide
        status, _h, body = self.up(data, headers={"Content-Type": "image/png", "Content-Disposition": 'attachment; filename="../../evil.png"'})
        self.assertEqual(status, 200, body)
        asset = json.loads(body)["asset"]
        self.assertEqual(asset["mime"], "image/jpeg")
        self.assertEqual(os.listdir(self.adir), [asset["id"] + ".jpg"])
        self.assertFalse((self.tmp / "evil.png").exists() or (self.tmp.parent / "evil.png").exists())
        self.assertNotIn(b"evil", body)

    def test_static_route_shape_and_security_headers_unchanged(self):
        # the asset route must not widen framing or CSP of any other response
        status, headers, _b = self._get("/api/carnet?meta=1")
        low = {k.lower(): v for k, v in headers.items()}
        self.assertEqual(low["x-frame-options"], "DENY")
        self.assertIn("frame-ancestors 'none'", low["content-security-policy"])
        self.assertEqual(low["x-content-type-options"], "nosniff")


class StaticMediaTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_browser_modules_have_no_dangerous_sinks(self):
        for name in ("hq-carnet-modal.js", "hq-carnet-media.js", "hq-carnet-rich.js", "hq-carnet.js", "hq-carnet-eng.js", "hq-carnet-eng-ui.js", "hq-carnet-history-ui.js", "hq-carnet-reviews.js", "hq-carnet-intel.js", "hq-carnet-intel-ui.js", "hq-carnet-ask.js", "hq-carnet-ask-ui.js", "hq-carnet-reviews-ui.js", "hq-carnet-portals.js", "hq-carnet-portals-ui.js", "hq-carnet-image-ui.js", "hq-carnet-struct.js", "hq-carnet-structured-ui.js", "hq-carnet-nav.js", "hq-carnet-polish-ui.js", "hq-carnet-dessiner.js", "hq-carnet-commands.js", "hq-carnet-editor-ui.js", "hq-carnet-templates.js", "hq-carnet-capture.js", "hq-carnet-motion.js", "hq-carnet-stickies.js", "hq-carnet-sizing.js", "hq-carnet-feel.js"):
            text = (self.ROOT / "assets" / name).read_text(encoding="utf-8")
            for bad in ("innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval(", "new Function", "importScripts", "XMLHttpRequest", "sendBeacon", "WebSocket"):
                self.assertNotIn(bad, text, f"{name}: {bad}")
        media_js = (self.ROOT / "assets" / "hq-carnet-media.js").read_text(encoding="utf-8")
        self.assertFalse(re.search(r"\bfetch\(", media_js), "the media module only uses the shared api() transport")
        self.assertNotIn("localStorage", media_js)
        self.assertNotIn("http://", media_js.replace("http://www.w3.org", ""))

    def test_page_loads_media_module_before_the_editor_and_retry_chain_keeps_stage05_shape(self):
        text = (self.ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        media_i = text.index("'hq-carnet-media.js'")
        rich_i = text.index("'hq-carnet-rich.js'")
        core_i = text.index("'hq-carnet.js'")
        self.assertLess(media_i, rich_i)
        self.assertLess(rich_i, core_i)
        block = text[text.index("const HQ_CARNET_SCRIPTS"):]
        block = block[: block.index("];")]
        pos = lambda n: block.index("'%s.js'" % n)
        # Stage 07: eng (model, needed by rich) after media, eng-ui (lazy UI) before the editor; the single loader list keeps the page order
        order = [pos(n) for n in ("hq-carnet-media", "hq-carnet-eng", "hq-carnet-struct", "hq-carnet-rich", "hq-carnet-field", "hq-carnet-field-ui", "hq-carnet-sources", "hq-carnet-eng-ui", "hq-carnet")]
        self.assertEqual(order, sorted(order))

    def test_handler_security_headers_default_is_unchanged(self):
        text = (self.ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertEqual(text.count('frame-ancestors \'self\''), 1, "only the Stage-05 PDF frame exception exists")
        self.assertIn("def _security_headers(self, *, frame_self: bool = False)", text)
        # no image response is ever framed: the only explicit frame_self=True uses are the Phase 9 r2 verified frozen-PDF route (body + readable refusal)
        start = text.index("def _carnet_reader_pdf(")
        end = text.index("    def _carnet_asset_get(")
        self.assertEqual(text.count("frame_self=True"), 2)
        self.assertEqual(text[start:end].count("frame_self=True"), 2, "both belong to the verified PDF route")

    def test_no_asset_deletion_api_exists(self):
        source = (self.ROOT / "hq_carnet_media.py").read_text(encoding="utf-8")
        for bad in ("unlink(", "os.remove", "shutil.rmtree", "rmdir"):
            # the ONLY deletions are the upload's own temp files
            for line in source.splitlines():
                if bad in line:
                    self.assertTrue("tmp" in line.lower() or "_remove_quiet" in line or "path.unlink" in line or "entry.path" in line, line)
        self.assertNotIn("asset_sweep", (self.ROOT / "hq_carnet.py").read_text(encoding="utf-8"))
        self.assertNotIn("asset_delete", (self.ROOT / "hq_carnet.py").read_text(encoding="utf-8"))
        self.assertFalse(any(a.startswith("asset_") for a in hq_carnet.ACTIONS))

    def test_client_limits_match_the_server(self):
        media_js = (self.ROOT / "assets" / "hq-carnet-media.js").read_text(encoding="utf-8")
        rich_js = (self.ROOT / "assets" / "hq-carnet-rich.js").read_text(encoding="utf-8")

        def const(text, name):
            m = re.search(rf"const {name} = ([0-9 *]+);", text)
            self.assertIsNotNone(m, name)
            total = 1
            for part in m.group(1).split("*"):
                total *= int(part)
            return total

        self.assertEqual(const(media_js, "LONG_SIDE"), media.MAX_LONG_SIDE)
        self.assertEqual(const(media_js, "FILE_MAX_BYTES"), media.MAX_FILE_BYTES)
        self.assertEqual(const(media_js, "SOURCE_MAX_BYTES"), media.SOURCE_MAX_BYTES)
        self.assertEqual(const(rich_js, "ASSET_LONG_SIDE_MAX"), rich.ASSET_LONG_SIDE_MAX)
        self.assertEqual(const(rich_js, "ASSET_WIDTH_MIN"), rich.ASSET_WIDTH_MIN)
        self.assertEqual(const(rich_js, "ASSET_WIDTH_MAX"), rich.ASSET_WIDTH_MAX)
        self.assertEqual(const(rich_js, "ASSET_CAPTION_MAX"), rich.ASSET_CAPTION_MAX)
        self.assertEqual(const(rich_js, "IMAGES_PER_PAGE_MAX"), rich.IMAGES_PER_PAGE_MAX)
        self.assertEqual((rich.ASSET_LONG_SIDE_MAX, rich.IMAGES_PER_PAGE_MAX, rich.ASSET_CAPTION_MAX), (media.MAX_LONG_SIDE, media.IMAGES_PER_PAGE_MAX, media.CAPTION_MAX))
        self.assertEqual((media.MAX_FILE_BYTES, media.SOURCE_MAX_BYTES, media.MAX_TOTAL_BYTES, media.MAX_FILES), (12 * MIB, 16 * MIB, 250 * MIB, 512))

    def test_caption_vectors_agree_with_the_browser_rule(self):
        """Same shared vectors as tests/check_hq_carnet_media.mjs: the server and the browser accept/reject identically."""
        data = json.loads((self.ROOT / "tests" / "fixtures_carnet_media.json").read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(data["captions"]), 20)
        for case in data["captions"]:
            asset = {"id": "asset-" + "a" * 24, "mime": "image/png", "w": 5, "h": 5, "width": 50, "layout": "inline", "caption": case["caption"]}
            try:
                out = rich.check_asset(asset)
                accepted = True
            except rich.ContentError:
                accepted = False
            self.assertEqual(accepted, case["ok"], case["name"])
            if accepted:
                self.assertEqual(out["caption"], case["caption"], case["name"])  # stored as-is, never normalised
            block = {"type": "image", "text": "", "marks": [], "asset": asset}
            self.assertEqual(rich.valid_v2({"version": 2, "blocks": [dict(block, id="block-x")]}), case["ok"], case["name"])

    def test_fixtures_agree_with_python_renderers(self):
        data = json.loads((self.ROOT / "tests" / "fixtures_carnet_media.json").read_text(encoding="utf-8"))
        for case in data["render"]:
            content = {"version": 2, "blocks": [dict(b, id=f"block-{i}") for i, b in enumerate(case["blocks"])]}
            self.assertTrue(rich.valid_v2(content), case["name"])
            self.assertEqual(rich.render_txt(content), case["txt"], case["name"])
            self.assertEqual(rich.render_markdown(content, case["paths"] or None), case["md"], case["name"])


# Only the new tests run: the Stage-01 API tests inherited through the shared server fixture are blanked, and
# MediaHttpSpoofTests (same fixture) keeps only its own tests. The imported base is dropped from the namespace.
for _name in dir(_ApiBase):
    if _name.startswith("test_"):
        setattr(MediaApiTests, _name, None) if _name not in MediaApiTests.__dict__ else None
for _name in [n for n in dir(MediaApiTests) if n.startswith("test_")]:
    if _name not in MediaHttpSpoofTests.__dict__:
        setattr(MediaHttpSpoofTests, _name, None)
del _ApiBase


if __name__ == "__main__":
    unittest.main()
