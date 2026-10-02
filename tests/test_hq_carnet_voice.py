"""Carnet Product Phase 4 — voice notes (immutable audio store), derived-text provenance (``from``), transcription adapter.

Throwaway ROOTs only (run from a disposable source copy: the HTTP part imports the bridge).
Browser behaviour: tests/check_hq_carnet_field.mjs (pure cores) and tests/visual_carnet_field_playwright.mjs.
"""

from __future__ import annotations

import io
import json
import os
import re
import sys
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import carnet_media_fixtures as F  # noqa: E402
import carnet_voice_fixtures as V  # noqa: E402
import cc_ext  # noqa: E402
import hq_carnet  # noqa: E402
import hq_carnet_media as media  # noqa: E402
import hq_carnet_rich as rich  # noqa: E402
import hq_carnet_voice as voice  # noqa: E402
import iphone_bridge  # noqa: E402
from test_hq_carnet_history import Stage08Base  # noqa: E402
from test_hq_carnet import ApiTests as _ApiBase  # noqa: E402
from test_hq_carnet import CarnetBase, NOW, _dir_symlink, _http  # noqa: E402

try:
    import test_backup_retention as _retention
except ImportError:  # pragma: no cover
    from tests import test_backup_retention as _retention

MIB = 1024 * 1024
AT = "2026-10-02T14:03:04Z"


def put(data: bytes, declared: str | None = None) -> dict:
    return voice.store_upload(io.BytesIO(data).read, len(data), declared)["voice"]


def vblock(v: dict, *, dur=83000, at=AT, block_id=None) -> dict:
    block = {"type": "voice", "text": "", "marks": [], "voice": {"id": v["id"], "mime": v["mime"], "dur_ms": dur, "recorded_at": at}}
    if block_id:
        block["id"] = block_id
    return block


def para(text="x", **extra):
    return {"type": "paragraph", "text": text, "marks": [], **extra}


def derived(text, kind, source_kind, source_id):
    return para(text, **{"from": {"kind": kind, "source_kind": source_kind, "source_id": source_id}})


class VoiceBase(CarnetBase):
    def setUp(self):
        super().setUp()
        for store in (media, voice):
            saved = dict(store._cb)
            self.addCleanup(lambda s=store, d=saved: (s._cb.clear(), s._cb.update(d)))
        for name in ("Inbox", "Uni", "Print"):
            (self.tmp / name).mkdir()
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        self.vdir = self.tmp / ".hq-carnet" / "voice"

    def files(self) -> list[str]:
        return sorted(os.listdir(self.vdir)) if self.vdir.is_dir() else []

    def new_page(self) -> dict:
        return hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]

    def save_blocks(self, page: dict, blocks: list[dict]) -> dict:
        return hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": blocks}})["page"]


# ---------------------------------------------------------------- container validation (pure)


class SniffTests(unittest.TestCase):
    def sniff(self, data: bytes) -> str:
        return voice.sniff(io.BytesIO(data), len(data))

    def refuse(self, data: bytes, code: str | None = None):
        with self.assertRaises(voice.VoiceError) as cm:
            self.sniff(data)
        if code:
            self.assertEqual(cm.exception.code, code)
        return cm.exception

    def test_valid_containers(self):
        self.assertEqual(self.sniff(V.webm()), "audio/webm")
        self.assertEqual(self.sniff(V.mp4()), "audio/mp4")
        self.assertEqual(self.sniff(V.mp4(brand=b"M4A ")), "audio/mp4")
        self.assertEqual(self.sniff(V.ogg()), "audio/ogg")
        self.assertEqual(self.sniff(V.ogg(head=b"\x01vorbis" + b"\x00" * 12)), "audio/ogg")

    def test_unknown_and_foreign_types_are_refused(self):
        for data in (b"", b"\x00" * 64, F.png(4, 4), F.jpeg(8, 8), V.wav(), b"%PDF-1.4 " + b"\x00" * 30, b"<svg/>", b"ID3\x03\x00" + b"\x00" * 40):
            self.refuse(data, "unsupported_type" if len(data) > 12 and not data.startswith(b"ID3") else None)

    def test_webm_must_be_webm_with_a_segment(self):
        self.refuse(V.webm(doctype=b"matroska"), "bad_audio")
        self.refuse(V.webm(with_segment=False), "bad_audio")
        self.refuse(V.webm()[:6], "bad_audio")
        self.refuse(b"\x1a\x45\xdf\xa3" + b"\xff" * 20, "bad_audio")  # unknown-size EBML header

    def test_mp4_structure(self):
        self.refuse(V.mp4(moov=False), "bad_audio")  # no moov
        self.refuse(V.mp4()[:-5], "bad_audio")  # truncated box
        self.refuse(V.mp4() + b"\x00\x00\x00", "bad_audio")  # trailing garbage that is not a box
        heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00heicmif1" + b"\x00" * 40
        self.refuse(heic, "bad_audio")  # an image container under the same ftyp magic has no moov
        self.refuse(b"\x00\x00\x00\x08ftyp", "bad_audio")  # ftyp too small

    def test_ogg_needs_a_head_packet(self):
        self.refuse(V.ogg(head=b"NotAnOpusHeader!"), "bad_audio")
        self.refuse(b"OggS" + b"\x00" * 8, "bad_audio")


# ---------------------------------------------------------------- upload / storage


class UploadTests(VoiceBase):
    def test_roundtrip_naming_and_metadata(self):
        data = V.webm(200)
        out = voice.store_upload(io.BytesIO(data).read, len(data), "audio/webm")
        v = out["voice"]
        self.assertEqual((v["mime"], v["bytes"]), ("audio/webm", len(data)))
        self.assertTrue(re.fullmatch(r"voice-[0-9a-f]{24}", v["id"]))
        self.assertEqual(self.files(), [v["id"] + ".webm"])
        handle, mime, size = voice.open_voice(v["id"])
        with handle:
            self.assertEqual((handle.read(), mime, size), (data, "audio/webm", len(data)))
        self.assertNotIn(str(self.tmp), json.dumps(out))

    def test_extension_follows_the_real_container(self):
        self.assertEqual(put(V.mp4())["mime"], "audio/mp4")
        self.assertEqual(put(V.ogg())["mime"], "audio/ogg")
        self.assertEqual(sorted(os.path.splitext(n)[1] for n in self.files()), [".m4a", ".ogg"])

    def test_bad_inputs_leave_no_residue(self):
        for data, declared, code in ((V.webm(), "audio/mp4", "mime_mismatch"), (V.webm(), "image/png", "unsupported_type"),
                                     (F.png(4, 4), None, "unsupported_type"), (b"\x00" * 100, None, "unsupported_type")):
            with self.assertRaises(voice.VoiceError) as cm:
                voice.store_upload(io.BytesIO(data).read, len(data), declared)
            self.assertEqual(cm.exception.code, code)
        for length in (0, -1, True, "5", None):
            with self.assertRaises(voice.VoiceError) as cm:
                voice.store_upload(io.BytesIO(b"x").read, length)
            self.assertEqual(cm.exception.code, "bad_length")
        self.assertEqual(self.files(), [])

    def test_size_limit_is_checked_before_any_read(self):
        reads = []
        with self.assertRaises(voice.VoiceError) as cm:
            voice.store_upload(lambda n: reads.append(n) or b"", voice.MAX_FILE_BYTES + 1)
        self.assertEqual((cm.exception.status, cm.exception.code, reads), (413, "file_too_large", []))

    def test_interrupted_and_overlong_bodies(self):
        data = V.webm(500)
        chunks = [data[:100]]
        with self.assertRaises(voice.VoiceError) as cm:
            voice.store_upload(lambda n: chunks.pop() if chunks else b"", len(data))
        self.assertEqual(cm.exception.code, "interrupted")
        with self.assertRaises(voice.VoiceError) as cm:
            voice.store_upload(lambda n: (data + b"zz")[: n + 2], len(data))
        self.assertEqual(cm.exception.code, "bad_length")
        self.assertEqual(self.files(), [])

    def test_quota_by_files_and_bytes_with_its_own_budget(self):
        with mock.patch.object(voice, "MAX_FILES", 2):
            put(V.webm(10))
            put(V.webm(11))
            with self.assertRaises(voice.VoiceError) as cm:
                put(V.webm(12))
            self.assertEqual((cm.exception.status, cm.exception.code), (507, "quota_exceeded"))
            self.assertIn("supprimée", str(cm.exception))  # explicit: nothing is deleted automatically
        with mock.patch.object(voice, "MAX_TOTAL_BYTES", len(V.webm(10)) * 2 + 5):
            with self.assertRaises(voice.VoiceError) as cm:
                put(V.webm(13))
            self.assertEqual(cm.exception.code, "quota_exceeded")
        # images have their own quota: a full voice store never blocks Stage-06 images
        with mock.patch.object(voice, "MAX_FILES", 0):
            self.assertEqual(media.store_upload(io.BytesIO(F.png(4, 4)).read, len(F.png(4, 4)))["asset"]["mime"], "image/png")
        self.assertEqual(voice.usage()["files"], len(self.files()))

    def test_concurrent_upload_slots_are_bounded(self):
        gate = threading.Event()
        started = threading.Barrier(3)

        def slow(n, data=V.webm(30)):
            started.wait(5)
            gate.wait(5)
            return data[:n]

        results = []

        def run():
            try:
                voice.store_upload(slow, len(V.webm(30)))
                results.append("ok")
            except voice.VoiceError as e:
                results.append(e.code)

        threads = [threading.Thread(target=run) for _ in range(2)]
        for t in threads:
            t.start()
        started.wait(5)
        with self.assertRaises(voice.VoiceError) as cm:
            put(V.webm(31))
        self.assertEqual((cm.exception.status, cm.exception.code), (429, "busy"))
        gate.set()
        for t in threads:
            t.join(5)
        self.assertEqual(sorted(results), ["ok", "ok"])
        self.assertEqual(len([n for n in self.files() if n.startswith(".tmp-")]), 0)

    def test_stale_tmp_files_are_reclaimed_and_unrelated_files_ignored(self):
        put(V.webm(10))
        stale = self.vdir / ".tmp-old"
        stale.write_bytes(b"x" * 10)
        os.utime(stale, (1, 1))
        (self.vdir / "notes.txt").write_text("unrelated", encoding="utf-8")
        put(V.webm(11))
        self.assertFalse(stale.exists())
        self.assertTrue((self.vdir / "notes.txt").exists())
        self.assertEqual(voice.usage()["files"], 2)

    def test_there_is_no_deletion_api(self):
        source = (Path(__file__).resolve().parent.parent / "hq_carnet_voice.py").read_text(encoding="utf-8")
        for bad in ("shutil.rmtree", "os.remove", "rmdir"):
            self.assertNotIn(bad, source)
        for line in source.splitlines():
            if "unlink(" in line:
                self.assertIn("entry.path", line + "entry.path") if "os.unlink(entry.path)" in line else self.fail(line)


class ConfinementTests(VoiceBase):
    def test_redirected_directories_are_refused(self):
        put(V.webm())
        real = self.tmp / "elsewhere"
        real.mkdir()
        self.vdir.rename(self.tmp / ".hq-carnet" / "voice-real")
        _dir_symlink(real, self.vdir)
        with self.assertRaises(voice.VoiceError) as cm:
            put(V.webm(5))
        self.assertEqual(cm.exception.code, "storage_error")
        self.assertNotIn(str(self.tmp), str(cm.exception))
        with self.assertRaises(voice.VoiceError):
            voice.open_voice("voice-" + "0" * 24)

    def test_ids_are_strictly_validated_and_symlinked_files_ignored(self):
        v = put(V.webm())
        for bad in ("../x", "voice-" + "g" * 24, "voice-" + "a" * 23, v["id"] + ".webm", "asset-" + "a" * 24, ""):
            with self.assertRaises(voice.VoiceError) as cm:
                voice.open_voice(bad)
            self.assertEqual(cm.exception.code, "not_found")
        target = self.tmp / "secret.webm"
        target.write_bytes(V.webm())
        link = self.vdir / ("voice-" + "b" * 24 + ".webm")
        try:
            os.symlink(target, link)
        except (OSError, NotImplementedError):  # pragma: no cover
            self.skipTest("symlinks unavailable")
        with self.assertRaises(voice.VoiceError):
            voice.open_voice("voice-" + "b" * 24)


# ---------------------------------------------------------------- schema: voice block + provenance


class SchemaTests(unittest.TestCase):
    ID = "voice-" + "a" * 24
    ASSET = "asset-" + "b" * 24

    def block(self, **over):
        return {"type": "voice", "text": "", "marks": [], "voice": {"id": self.ID, "mime": "audio/webm", "dur_ms": 1500, "recorded_at": AT, **over}}

    def parse(self, blocks, existing=None):
        return rich.parse_content({"version": 2, "blocks": blocks}, existing=existing or {"version": 2, "blocks": []}, folders=("Inbox",), system_names=frozenset(), text_limit=48 * 1024)

    def test_valid_voice_block_roundtrips_canonically(self):
        out = self.parse([self.block()])["blocks"][0]
        self.assertEqual(out["voice"], {"id": self.ID, "mime": "audio/webm", "dur_ms": 1500, "recorded_at": AT})
        self.assertEqual((out["text"], out["marks"]), ("", []))

    def test_voice_payload_is_strict(self):
        bad = [dict(id="asset-" + "a" * 24), dict(id="voice-" + "A" * 24), dict(id="../x"), dict(mime="audio/wav"), dict(mime="video/webm"),
               dict(dur_ms=0), dict(dur_ms=-1), dict(dur_ms=600001), dict(dur_ms=1.5), dict(dur_ms=True), dict(dur_ms="9"),
               dict(recorded_at="2026-10-02"), dict(recorded_at="2026-13-02T10:00:00Z"), dict(recorded_at="2026-02-30T10:00:00Z"),
               dict(recorded_at="1999-01-01T00:00:00Z"), dict(recorded_at="2026-10-02T10:00:00+00:00"), dict(recorded_at=20261002)]
        for over in bad:
            with self.assertRaises(rich.ContentError, msg=over):
                self.parse([self.block(**over)])
        for mutate in (lambda b: b["voice"].pop("recorded_at"), lambda b: b["voice"].update(extra=1), lambda b: b.update(text="x"),
                       lambda b: b.update(marks=[{"type": "bold", "start": 0, "end": 1}]), lambda b: b.update(asset={}), lambda b: b.update(checked=False),
                       lambda b: b.update(drawing={"id": "x"})):
            b = self.block()
            mutate(b)
            with self.assertRaises(rich.ContentError):
                self.parse([b])

    def test_block_id_and_voice_asset_id_are_distinct_namespaces(self):
        b = self.block()
        b["id"] = self.ID  # a voice asset id is never accepted as a block id
        with self.assertRaises(rich.ContentError):
            self.parse([b])
        self.assertTrue(rich.VOICE_ID_RE.match(self.ID) and not rich._BLOCK_ID_RE.match(self.ID))

    def test_per_page_limits(self):
        blocks = [self.block() for _ in range(rich.VOICES_PER_PAGE_MAX)]
        self.parse(blocks)
        with self.assertRaises(rich.ContentError):
            self.parse(blocks + [self.block()])

    def test_provenance_shape_and_pairing(self):
        ok_ocr = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        ok_tr = {"kind": "transcript", "source_kind": "voice", "source_id": self.ID}
        out = self.parse([para("a", **{"from": ok_ocr}), para("b", **{"from": ok_tr}), para("c")])["blocks"]
        self.assertEqual((out[0]["from"], out[1]["from"], "from" in out[2]), (ok_ocr, ok_tr, False))
        bad = [
            {"kind": "ocr", "source_kind": "voice", "source_id": self.ID},  # ocr may only come from an image asset
            {"kind": "transcript", "source_kind": "asset", "source_id": self.ASSET},
            {"kind": "ocr", "source_kind": "asset", "source_id": "Inbox/Uni/scan.png"},  # never a path
            {"kind": "ocr", "source_kind": "asset", "source_id": "https://x/y.png"},
            {"kind": "ocr", "source_kind": "file", "source_id": self.ASSET},
            {"kind": "summary", "source_kind": "asset", "source_id": self.ASSET},
            {**ok_ocr, "confidence": 0.9},  # no confidence blob
            {**ok_ocr, "engine": "tesseract"},
            {"kind": "ocr", "source_kind": "asset"},
            "ocr", None, [], 5,
        ]
        for value in bad:
            with self.assertRaises(rich.ContentError, msg=value):
                self.parse([para("a", **{"from": value})])

    def test_only_a_paragraph_can_carry_provenance(self):
        src = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        for kind in ("heading", "bullet", "number", "check"):
            with self.assertRaises(rich.ContentError, msg=kind):
                self.parse([{"type": kind, "text": "x", "marks": [], **({"checked": False} if kind == "check" else {}), "from": src}])
        with self.assertRaises(rich.ContentError):
            self.parse([{**self.block(), "from": src}])

    def test_derived_block_cap(self):
        src = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        self.parse([para(f"l{i}", **{"from": src}) for i in range(rich.DERIVED_BLOCKS_PER_PAGE_MAX)])
        with self.assertRaises(rich.ContentError):
            self.parse([para(f"l{i}", **{"from": src}) for i in range(rich.DERIVED_BLOCKS_PER_PAGE_MAX + 1)])

    def test_provenance_is_part_of_canonical_equality(self):
        src = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        stored = rich.store_content(self.parse([para("a", **{"from": src})]), {"version": 2, "blocks": []})
        self.assertTrue(rich.valid_v2(stored))
        self.assertTrue(rich.same_as_stored(self.parse([{**stored["blocks"][0]}], stored), stored))
        plain = {**stored["blocks"][0]}
        plain.pop("from")
        self.assertFalse(rich.same_as_stored(self.parse([plain], stored), stored))  # dropping provenance is a real change
        other = {**stored["blocks"][0], "from": {**src, "source_id": "asset-" + "c" * 24}}
        self.assertFalse(rich.same_as_stored(self.parse([other], stored), stored))

    def test_stored_shape_validation(self):
        src = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        good = rich.store_content(self.parse([para("a", **{"from": src}), self.block()]), {"version": 2, "blocks": []})
        self.assertTrue(rich.valid_v2(good))
        for tamper in (lambda c: c["blocks"][0]["from"].update(extra=1), lambda c: c["blocks"][0].update({"from": "x"}),
                       lambda c: c["blocks"][0].update(type="heading"), lambda c: c["blocks"][1]["voice"].update(dur_ms=0),
                       lambda c: c["blocks"][1].update({"from": src})):
            c = json.loads(json.dumps(good))
            tamper(c)
            self.assertFalse(rich.valid_v2(c))

    def test_exports_label_voice_and_mark_derived_runs(self):
        src = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        tr = {"kind": "transcript", "source_kind": "voice", "source_id": self.ID}
        content = rich.store_content(self.parse([para("avant"), self.block(), para("l1", **{"from": src}), para("l2", **{"from": src}),
                                                  para("libre"), para("t1", **{"from": tr})]), {"version": 2, "blocks": []})
        txt = rich.render_txt(content)
        self.assertEqual(txt, "avant\n[Note vocale · 0:02]\n[Texte extrait d'un scan (OCR)]\nl1\nl2\nlibre\n[Transcription d'une note vocale]\nt1\n")
        md = rich.render_markdown(content)
        self.assertEqual(md.count("Texte extrait d'un scan (OCR)"), 1)
        self.assertIn("Transcription d'une note vocale", md)
        self.assertIn("Note vocale", md)
        for forbidden in (self.ID, self.ASSET, "voice-", "asset-"):
            self.assertNotIn(forbidden, txt + md)

    def test_closure_helpers(self):
        src = {"kind": "ocr", "source_kind": "asset", "source_id": self.ASSET}
        tr = {"kind": "transcript", "source_kind": "voice", "source_id": "voice-" + "d" * 24}
        content = rich.store_content(self.parse([self.block(), para("a", **{"from": src}), para("t", **{"from": tr})]), {"version": 2, "blocks": []})
        self.assertEqual(sorted(rich.voices_of(content)), sorted([self.ID, "voice-" + "d" * 24]))
        self.assertEqual([x for b in content["blocks"] for x in rich.block_provenance_assets(b)], [self.ASSET])
        self.assertEqual(rich.assets_of(content), [])  # provenance is not an image block: never rendered or exported as one


# ---------------------------------------------------------------- page save / verification


class SaveTests(VoiceBase):
    def test_a_stored_voice_note_can_be_referenced_and_reloads(self):
        v = put(V.webm())
        page = self.save_blocks(self.new_page(), [para("avant"), vblock(v)])
        stored = page["content"]["blocks"][1]
        self.assertEqual(stored["voice"]["id"], v["id"])
        self.assertEqual(rich.voices_of(page["content"]), [v["id"]])
        self.assertTrue(stored["id"].startswith("block-") and stored["id"] != v["id"])

    def test_unknown_or_inconsistent_voice_is_refused_and_page_untouched(self):
        page = self.new_page()
        ghost = {"id": "voice-" + "e" * 24, "mime": "audio/webm"}
        with self.assertRaises(hq_carnet.CarnetError) as cm:
            self.save_blocks(page, [vblock(ghost)])
        self.assertIn("inconnue", str(cm.exception))
        real = put(V.webm())
        with self.assertRaises(hq_carnet.CarnetError) as cm:
            self.save_blocks(page, [vblock({**real, "mime": "audio/mp4"})])
        self.assertIn("incohérent", str(cm.exception))
        self.assertEqual(hq_carnet.get_notebook()["pages"][0]["rev"], page["rev"])

    def test_a_missing_file_behind_an_already_stored_reference_does_not_block_other_edits(self):
        v = put(V.webm())
        page = self.save_blocks(self.new_page(), [vblock(v)])
        (self.vdir / (v["id"] + ".webm")).unlink()
        again = self.save_blocks(page, [vblock(v, block_id=page["content"]["blocks"][0]["id"]), para("ajout")])
        self.assertEqual(len(again["content"]["blocks"]), 2)

    def test_provenance_requires_an_existing_source_only_when_new(self):
        v = put(V.webm())
        image = media.store_upload(io.BytesIO(F.png(8, 8)).read, len(F.png(8, 8)))["asset"]
        page = self.new_page()
        with self.assertRaises(hq_carnet.CarnetError) as cm:
            self.save_blocks(page, [derived("x", "ocr", "asset", "asset-" + "f" * 24)])
        self.assertIn("Source de provenance", str(cm.exception))
        with self.assertRaises(hq_carnet.CarnetError):
            self.save_blocks(page, [derived("x", "transcript", "voice", "voice-" + "f" * 24)])
        saved = self.save_blocks(page, [derived("ocr text", "ocr", "asset", image["id"]), derived("tr text", "transcript", "voice", v["id"])])
        self.assertEqual([b["from"]["source_id"] for b in saved["content"]["blocks"]], [image["id"], v["id"]])
        (self.vdir / (v["id"] + ".webm")).unlink()  # source disappears: the text and its provenance are preserved, never rewritten
        edited = self.save_blocks(saved, [{**saved["content"]["blocks"][0]}, {**saved["content"]["blocks"][1], "text": "tr text corrected"}])
        self.assertEqual(edited["content"]["blocks"][1]["from"]["source_id"], v["id"])

    def test_deleting_derived_text_deletes_no_source(self):
        v = put(V.webm())
        page = self.save_blocks(self.new_page(), [vblock(v), derived("t", "transcript", "voice", v["id"])])
        self.save_blocks(page, [{**page["content"]["blocks"][0]}])
        self.assertEqual(self.files(), [v["id"] + ".webm"])

    def test_limits_payload_advertises_phase4_budgets(self):
        lim = hq_carnet.get_notebook()["limits"]
        for key, want in (("voice_file_bytes", 16 * MIB), ("voice_total_bytes", 250 * MIB), ("voice_files", 256), ("voice_duration_ms", 600000),
                          ("transcript_chars", 20000), ("derived_blocks_per_page", rich.DERIVED_BLOCKS_PER_PAGE_MAX)):
            self.assertEqual(lim[key], want, key)
        self.assertEqual(lim["media_files"], 512)  # image budget unchanged


# ---------------------------------------------------------------- transcription adapter


class TranscribeTests(VoiceBase):
    def engine(self, body: str) -> list[str]:
        script = self.tmp / "engine.py"
        script.write_text(body, encoding="utf-8")
        return [sys.executable, str(script), "{input}"]

    def run_tr(self, v, command, wav=None, **kw):
        data = V.wav() if wav is None else wav
        return voice.transcribe(v["id"], io.BytesIO(data).read, len(data), command, **kw)

    def test_unconfigured_is_a_clear_501_and_reads_nothing(self):
        v = put(V.webm())
        reads = []
        with self.assertRaises(voice.VoiceError) as cm:
            voice.transcribe(v["id"], lambda n: reads.append(n) or b"", 100, None)
        self.assertEqual((cm.exception.status, cm.exception.code, str(cm.exception), reads), (501, "transcribe_unconfigured", "Transcription non configurée", []))
        for bad in ([], ["relative.exe", "{input}"], [sys.executable], [sys.executable, "no-placeholder"], "cmd {input}", [sys.executable, 5, "{input}"],
                    [str(self.tmp / "missing.exe"), "{input}"]):
            self.assertFalse(voice.transcribe_configured(bad), bad)

    def test_unknown_voice_is_404(self):
        with self.assertRaises(voice.VoiceError) as cm:
            voice.transcribe("voice-" + "0" * 24, io.BytesIO(V.wav()).read, len(V.wav()), self.engine("print('x')"))
        self.assertEqual(cm.exception.status, 404)

    def test_fake_engine_success_returns_clean_text(self):
        v = put(V.webm())
        cmd = self.engine("import sys,os\nassert open(sys.argv[1],'rb').read(4)==b'RIFF'\nprint('  Bonjour   le monde  ')\nprint()\nprint('deuxième ligne')\n")
        out = self.run_tr(v, cmd)
        self.assertEqual(out, {"ok": True, "text": "Bonjour le monde\ndeuxième ligne", "chars": len("Bonjour le monde\ndeuxième ligne")})

    def test_engine_failures_never_leak_paths_or_stderr(self):
        v = put(V.webm())
        for body, code in (("import sys; sys.stderr.write('/secret/path'); sys.exit(3)", "transcribe_failed"), ("print('')", "transcript_empty"),
                           ("import sys; sys.stdout.buffer.write(b'\\xff\\xfe')", "transcribe_failed")):
            with self.assertRaises(voice.VoiceError) as cm:
                self.run_tr(v, self.engine(body))
            self.assertEqual(cm.exception.code, code)
            self.assertNotIn("secret", str(cm.exception))
            self.assertNotIn(str(self.tmp), str(cm.exception))

    def test_transcript_above_the_limit_is_refused_not_truncated(self):
        v = put(V.webm())
        with self.assertRaises(voice.VoiceError) as cm:
            self.run_tr(v, self.engine(f"print('a' * {voice.TRANSCRIPT_CHARS_MAX + 1})"))
        self.assertEqual((cm.exception.status, cm.exception.code), (413, "transcript_too_long"))
        ok = self.run_tr(v, self.engine(f"print('a' * {voice.TRANSCRIPT_CHARS_MAX})"))
        self.assertEqual(ok["chars"], voice.TRANSCRIPT_CHARS_MAX)

    def test_timeout_and_busy_slot(self):
        v = put(V.webm())
        with self.assertRaises(voice.VoiceError) as cm:
            self.run_tr(v, self.engine("import time; time.sleep(30)"), timeout=0.4)
        self.assertEqual((cm.exception.status, cm.exception.code), (504, "transcribe_timeout"))
        self.assertTrue(voice._transcribe_slot.acquire(blocking=False))
        try:
            with self.assertRaises(voice.VoiceError) as cm:
                self.run_tr(v, self.engine("print('x')"))
            self.assertEqual(cm.exception.code, "busy")
        finally:
            voice._transcribe_slot.release()

    def test_body_validation(self):
        v = put(V.webm())
        cmd = self.engine("print('x')")
        for data, code in ((b"not a wav at all, definitely not riff data xxxxxxxxxxxxxxxxxxxxxxxxxxxx", "bad_wav"), (b"short", "bad_length")):
            with self.assertRaises(voice.VoiceError) as cm:
                self.run_tr(v, cmd, wav=data)
            self.assertEqual(cm.exception.code, code)
        with self.assertRaises(voice.VoiceError) as cm:
            voice.transcribe(v["id"], lambda n: b"", voice.WAV_MAX_BYTES + 1, cmd)
        self.assertEqual(cm.exception.code, "bad_length")

    def test_the_temp_wav_is_removed_and_the_stored_audio_is_untouched(self):
        v = put(V.webm(77))
        seen = []
        cmd = self.engine("import sys; print(sys.argv[1])")
        out = self.run_tr(v, cmd)
        seen.append(out["text"])
        self.assertFalse(os.path.exists(seen[0]))
        handle, _m, _s = voice.open_voice(v["id"])
        with handle:
            self.assertEqual(handle.read(), V.webm(77))

    def test_command_never_goes_through_a_shell(self):
        source = (Path(__file__).resolve().parent.parent / "hq_carnet_voice.py").read_text(encoding="utf-8")
        self.assertNotIn("shell=True", source)
        self.assertNotIn("os.system", source)


# ---------------------------------------------------------------- backup / history


class BackupVoiceTests(_retention.RetentionBase):
    def setUp(self):
        super().setUp()
        saved, saved_ready = dict(hq_carnet._cb), hq_carnet._ready
        saved_stores = [dict(media._cb), dict(voice._cb)]

        def restore():
            hq_carnet._cb.clear()
            hq_carnet._cb.update(saved)
            hq_carnet._ready = saved_ready
            for store, data in zip((media, voice), saved_stores):
                store._cb.clear()
                store._cb.update(data)

        self.addCleanup(restore)
        hq_carnet.bind(root=self.root, now=lambda: NOW, folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)
        self.vdir = self.root / ".hq-carnet" / "voice"

    def page_with(self, blocks) -> dict:
        nb = hq_carnet.mutate({"action": "page_create", "expected_notebook_rev": hq_carnet.get_notebook()["notebook_rev"]})["page"]
        return hq_carnet.mutate({"action": "page_save", "id": nb["id"], "expected_rev": nb["rev"], "content": {"version": 2, "blocks": blocks}})["page"]

    def backup(self):
        info = cc_ext.run_backup(force=True)
        return info, Path(info["path"]) / "Carnet"

    def test_voice_notes_and_transcript_sources_travel_with_the_backup(self):
        v1, v2, orphan = put(V.webm(40)), put(V.mp4(50)), put(V.ogg())
        self.page_with([vblock(v1)])
        self.page_with([derived("transcript of the second", "transcript", "voice", v2["id"])])  # only provenance references v2
        info, dest = self.backup()
        self.assertTrue(info["carnet"]["valid"])
        self.assertEqual(info["carnet"]["voice"], {"count": 2, "bytes": len(V.webm(40)) + len(V.mp4(50)), "missing": 0})
        self.assertEqual(sorted(os.listdir(dest / "voice")), sorted([v1["id"] + ".webm", v2["id"] + ".m4a"]))
        self.assertEqual((dest / "voice" / (v1["id"] + ".webm")).read_bytes(), V.webm(40))
        self.assertFalse((dest / "voice" / (orphan["id"] + ".ogg")).exists())
        saved = json.loads((dest / "notebook.json").read_text(encoding="utf-8"))  # notebook source relationships survive recovery
        blocks = [b for p in saved["pages"] for b in p["content"]["blocks"]]
        self.assertTrue(any(b.get("voice", {}).get("id") == v1["id"] for b in blocks))
        self.assertTrue(any(b.get("from", {}).get("source_id") == v2["id"] for b in blocks))
        self.assertNotIn(str(self.root), json.dumps(info["carnet"]))
        self.assertTrue(rich.valid_v2(next(p["content"] for p in saved["pages"] if any("from" in b for b in p["content"]["blocks"]))))

    def test_ocr_source_images_are_kept_as_evidence(self):
        image = media.store_upload(io.BytesIO(F.png(6, 6)).read, len(F.png(6, 6)))["asset"]
        self.page_with([derived("text from a scan", "ocr", "asset", image["id"])])  # the scan block itself is gone
        info, dest = self.backup()
        self.assertEqual(info["carnet"]["assets"]["count"], 1)
        self.assertTrue((dest / "assets" / (image["id"] + ".png")).exists())

    def test_a_missing_voice_file_makes_the_snapshot_invalid_without_failing(self):
        v = put(V.webm())
        self.page_with([vblock(v)])
        (self.vdir / (v["id"] + ".webm")).unlink()
        info, _dest = self.backup()
        self.assertFalse(info["carnet"]["valid"])
        self.assertEqual(info["carnet"]["voice"]["missing"], 1)

    def test_no_voice_keeps_the_accepted_status_shape(self):
        self.page_with([para("x")])
        info, dest = self.backup()
        self.assertEqual(set(info["carnet"]), {"ok", "included", "status", "bytes", "valid"})
        self.assertEqual(os.listdir(dest), ["notebook.json"])

    def test_history_closure_keeps_voice_of_a_retained_checkpoint(self):
        v = put(V.webm(33))
        page = self.page_with([vblock(v)])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("voice removed")]}})
        info, dest = self.backup()
        self.assertEqual(info["carnet"]["voice"]["count"], 1)
        self.assertTrue((dest / "voice" / (v["id"] + ".webm")).exists())


class HistoryVoiceTests(Stage08Base):
    def setUp(self):
        super().setUp()
        for store in (media, voice):
            saved = dict(store._cb)
            self.addCleanup(lambda s=store, d=saved: (s._cb.clear(), s._cb.update(d)))
        hq_carnet.bind(root=self.tmp, now=lambda: self.clock[0], folders=lambda: ["Inbox", "Uni", "Print"],
                       system_names=iphone_bridge.SYSTEM_NAMES, safe_leaf_name=iphone_bridge.safe_leaf_name)

    def test_restore_brings_the_voice_block_back_and_deletes_no_audio(self):
        v = put(V.webm(21))
        page = self.make_page([para("avant"), vblock(v), derived("transcript", "transcript", "voice", v["id"])])
        want = [(b["type"], b.get("voice"), b.get("from")) for b in page["content"]["blocks"]]
        cp = hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})[1]["event_id"]
        edited = hq_carnet.mutate({"action": "page_save", "id": page["id"], "expected_rev": page["rev"], "content": {"version": 2, "blocks": [para("tout efface")]}})["page"]
        status, out = hq_carnet.http_post({"action": "history_restore", "page_id": page["id"], "event_id": cp, "expected_rev": edited["rev"], "confirm": True})
        self.assertEqual(status, 200, out)
        got = [(b["type"], b.get("voice"), b.get("from")) for b in self.cur(page["id"])["content"]["blocks"]]
        self.assertEqual(got, want)
        self.assertEqual(os.listdir(self.tmp / ".hq-carnet" / "voice"), [v["id"] + ".webm"])

    def test_history_holds_references_not_audio_bytes(self):
        v = put(V.webm(5000))
        page = self.make_page([vblock(v)])
        hq_carnet.http_post({"action": "history_checkpoint", "page_id": page["id"], "expected_rev": page["rev"]})
        hist = (self.tmp / ".hq-carnet" / "history.json").read_bytes()
        self.assertLess(len(hist), 3000)
        self.assertNotIn(b"base64", hist)


# ---------------------------------------------------------------- HTTP


class VoiceApiTests(_ApiBase):
    """Reuses the throwaway loopback server of the Stage-01 API tests (temp ROOT, fake PINs)."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.vdir = cls.tmp / ".hq-carnet" / "voice"

    def setUp(self):
        super().setUp()
        if self.vdir.exists():
            for name in os.listdir(self.vdir):
                (self.vdir / name).unlink()

    def up(self, data, *, cookie=None, mime=None, origin=True, headers=None, path="/api/carnet/voice"):
        hdrs = {"Content-Type": "application/octet-stream"}
        if origin:
            hdrs["Origin"] = f"http://127.0.0.1:{self.port}"
        if mime:
            hdrs["X-Carnet-Mime"] = mime
        hdrs.update(headers or {})
        return _http(self.port, "POST", path, body=data, headers=hdrs, cookie=self.admin if cookie is None else cookie)

    def test_upload_roundtrip_serving_and_ranges(self):
        data = V.webm(5000)
        status, _h, body = self.up(data, mime="audio/webm")
        self.assertEqual(status, 200, body)
        v = json.loads(body)["voice"]
        self.assertEqual((v["mime"], v["bytes"]), ("audio/webm", len(data)))
        self.assertNotIn(str(self.tmp).encode(), body)
        status, headers, served = self._get("/api/carnet/voice/" + v["id"])
        self.assertEqual((status, served), (200, data))
        low = {k.lower(): val for k, val in headers.items()}
        self.assertEqual(low["content-type"], "audio/webm")
        self.assertEqual(low["accept-ranges"], "bytes")
        self.assertEqual(low["x-content-type-options"], "nosniff")
        self.assertIn("sandbox", low["content-security-policy"])
        self.assertEqual(low["cache-control"], "private, no-cache")
        status, headers, part = _http(self.port, "GET", "/api/carnet/voice/" + v["id"], headers={"Range": "bytes=100-199"}, cookie=self.admin)
        self.assertEqual((status, part), (206, data[100:200]))
        self.assertEqual({k.lower(): val for k, val in headers.items()}["content-range"], f"bytes 100-199/{len(data)}")
        status, _h, tail = _http(self.port, "GET", "/api/carnet/voice/" + v["id"], headers={"Range": "bytes=-50"}, cookie=self.admin)
        self.assertEqual((status, tail), (206, data[-50:]))
        status, _h, rest = _http(self.port, "GET", "/api/carnet/voice/" + v["id"], headers={"Range": f"bytes={len(data) - 10}-"}, cookie=self.admin)
        self.assertEqual((status, rest), (206, data[-10:]))
        status, headers, _b = _http(self.port, "GET", "/api/carnet/voice/" + v["id"], headers={"Range": f"bytes={len(data)}-"}, cookie=self.admin)
        self.assertEqual(status, 416)
        status, _h, full = _http(self.port, "GET", "/api/carnet/voice/" + v["id"], headers={"Range": "bytes=zzz"}, cookie=self.admin)
        self.assertEqual((status, full), (200, data))  # an unparseable Range is ignored (RFC 9110)
        status, _h, empty = _http(self.port, "GET", "/api/carnet/voice/" + v["id"], headers={"If-None-Match": '"' + v["id"] + '"'}, cookie=self.admin)
        self.assertEqual((status, empty), (304, b""))

    def test_auth_and_origin_are_enforced(self):
        data = V.webm()
        self.assertEqual(self.up(data, cookie="")[0], 401)
        self.assertEqual(self.up(data, cookie=self.upload)[0], 403)
        self.assertEqual(self.up(data, origin=False)[0], 403)
        self.assertEqual(self.up(data, headers={"Origin": "http://evil.example"})[0], 403)
        ok = json.loads(self.up(data)[2])["voice"]
        self.assertEqual(_http(self.port, "GET", "/api/carnet/voice/" + ok["id"], cookie="")[0], 401)
        self.assertEqual(self._get("/api/carnet/voice/" + ok["id"], cookie=self.upload)[0], 403)
        for route in ("/api/carnet/voice", "/api/carnet/transcribe"):
            self.assertEqual(_http(self.port, "GET", route, cookie="")[0], 401)
            self.assertEqual(self._get(route, cookie=self.upload)[0], 403)
        self.assertEqual(self.up(V.wav(), path="/api/carnet/voice/" + ok["id"] + "/transcribe", cookie=self.upload)[0], 403)

    def test_refusals_are_path_free_and_leave_nothing(self):
        for data, headers, want in ((F.png(4, 4), None, 415), (V.webm(), {"X-Carnet-Mime": "audio/mp4"}, 415), (b"", None, 400),
                                    (V.webm(), {"Transfer-Encoding": "chunked"}, 411)):
            status, _h, body = self.up(data, headers=headers)
            self.assertEqual(status, want, body)
            self.assertNotIn(str(self.tmp).encode(), body)
        self.assertEqual(os.listdir(self.vdir) if self.vdir.exists() else [], [])

    def test_unknown_and_malformed_ids(self):
        for bad in ("voice-" + "0" * 24, "x", "..%2f..%2fnotebook.json", "asset-" + "a" * 24, "voice-" + "0" * 24 + ".webm"):
            status, _h, body = self._get("/api/carnet/voice/" + bad)
            self.assertIn(status, (400, 404), (bad, status))
            self.assertNotIn(str(self.tmp).encode(), body)

    def test_usage_endpoint(self):
        self.up(V.mp4(100))
        status, _h, body = self._get("/api/carnet/voice")
        usage = json.loads(body)
        self.assertEqual((status, usage["files"], usage["max_files"], usage["max_bytes"]), (200, 1, 256, 250 * MIB))

    def test_transcribe_endpoint_unconfigured_and_configured(self):
        v = json.loads(self.up(V.webm())[2])["voice"]
        path = "/api/carnet/voice/" + v["id"] + "/transcribe"
        status, _h, body = self._get("/api/carnet/transcribe")
        self.assertEqual((status, json.loads(body)["configured"]), (200, False))
        status, _h, body = self.up(V.wav(), path=path)
        self.assertEqual((status, json.loads(body)["error"]), (501, "Transcription non configurée"))
        script = self.tmp / "engine.py"
        script.write_text("print('bonjour de test')", encoding="utf-8")
        with mock.patch.dict(iphone_bridge.CONFIG, {"transcribe_command": [sys.executable, str(script), "{input}"]}):
            self.assertTrue(json.loads(self._get("/api/carnet/transcribe")[2])["configured"])
            status, _h, body = self.up(V.wav(), path=path)
            self.assertEqual((status, json.loads(body)["text"]), (200, "bonjour de test"))
            status, _h, body = self.up(V.wav(), path="/api/carnet/voice/voice-" + "0" * 24 + "/transcribe")
            self.assertEqual(status, 404)
            status, _h, body = self.up(b"not-a-wav" * 10, path=path)
            self.assertEqual((status, json.loads(body)["code"]), (400, "bad_wav"))

    def test_page_save_round_trip_over_http(self):
        v = json.loads(self.up(V.webm())[2])["voice"]
        nb = json.loads(self._get("/api/carnet")[2])
        status, _h, body = self._post({"action": "page_create", "expected_notebook_rev": nb["notebook_rev"]})
        page = json.loads(body)["page"]
        status, _h, body = self._post({"action": "page_save", "id": page["id"], "expected_rev": page["rev"],
                                       "content": {"version": 2, "blocks": [vblock(v)]}})
        self.assertEqual(status, 200, body)
        status, _h, body = self._post({"action": "page_save", "id": page["id"], "expected_rev": 2,
                                       "content": {"version": 2, "blocks": [vblock({"id": "voice-" + "9" * 24, "mime": "audio/webm"})]}})
        self.assertEqual(status, 400, body)


for _name in dir(_ApiBase):  # the Stage-01 API tests are fixture-only here: do not run them a second time
    if _name.startswith("test") and _name not in VoiceApiTests.__dict__:
        setattr(VoiceApiTests, _name, None)


class StaticVoiceTests(unittest.TestCase):
    ROOT = Path(__file__).resolve().parent.parent

    def test_csp_only_relaxes_wasm_for_the_ocr_worker_script(self):
        text = (self.ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertEqual(text.count("wasm-unsafe-eval"), 1)
        self.assertIn('self._wasm_ok = name == "vendor-tesseract-worker.min.js"', text)
        self.assertIn("script-src 'self' 'unsafe-inline'; connect-src 'self'", text)
        self.assertNotIn("worker-src", text)  # no blob: workers are allowed

    def test_vendored_ocr_files_match_the_recorded_hashes(self):
        import hashlib

        third = (self.ROOT / "THIRD_PARTY.txt").read_text(encoding="utf-8")
        for name in ("vendor-tesseract.min.js", "vendor-tesseract-worker.min.js", "vendor-tesseract-core-simd-lstm.wasm.js", "eng.traineddata.gz", "fra.traineddata.gz"):
            data = (self.ROOT / "assets" / name).read_bytes()
            self.assertIn(hashlib.sha256(data).hexdigest(), third, name)
            self.assertIn(f"{len(data):,} bytes", third, name)
        self.assertTrue((self.ROOT / "TESSERACT-LICENSE.txt").is_file())

    def test_vendored_licence_is_a_protected_system_file(self):
        # a loose file at the HQ root is treated as an Inbox item and swept into Inbox/ unless it is a system name
        # (this really happened to TESSERACT-LICENSE.txt during the suite)
        import iphone_bridge
        self.assertIn("tesseract-license.txt", iphone_bridge.SYSTEM_NAMES)

    def test_no_cloud_endpoints_in_the_phase4_sources(self):
        for name in ("hq_carnet_voice.py", "assets/hq-carnet-field.js", "assets/hq-carnet-field-ui.js"):
            path = self.ROOT / name
            if not path.exists():
                continue
            text = path.read_text(encoding="utf-8")
            self.assertFalse(re.search(r"https?://(?!www\.w3\.org)", text), name)
            for bad in ("XMLHttpRequest", "sendBeacon", "WebSocket", "navigator.serviceWorker", "SpeechRecognition", "webkitSpeechRecognition"):
                self.assertNotIn(bad, text, f"{name}: {bad}")


class FixtureDriftTests(unittest.TestCase):
    """The Node parity check consumes tests/fixtures_carnet_field.json; it must be exactly what Python generates today."""

    def test_shared_fixture_matches_the_python_implementation(self):
        import json
        import sys
        here = Path(__file__).resolve().parent
        sys.path.insert(0, str(here))
        try:
            import gen_fixtures_carnet_field as gen
        finally:
            sys.path.remove(str(here))
        want = json.loads(json.dumps(gen.build()))
        have = json.loads((here / "fixtures_carnet_field.json").read_text(encoding="utf-8"))
        self.assertEqual(want, have, "regenerate with: python3 tests/gen_fixtures_carnet_field.py")


if __name__ == "__main__":
    unittest.main()
