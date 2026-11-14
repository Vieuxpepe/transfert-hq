"""Forge Studio sessions, normal-gallery labels/search and outpaint geometry."""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_gallery as G  # noqa: E402
import hq_forge_inpaint as I  # noqa: E402
import hq_forge_library as L  # noqa: E402


def _png(width: int = 512, height: int = 512, color=(20, 40, 60)) -> bytes:
    out = io.BytesIO()
    Image.new("RGB", (width, height), color).save(out, format="PNG")
    return out.getvalue()


def _settings(prompt: str = "un phare", seed: int = 7, checkpoint: str = "example.safetensors [abcd]") -> dict:
    return {
        "prompt": prompt, "negative_prompt": "", "checkpoint": checkpoint,
        "sampler_name": "Euler", "scheduler": "automatic", "width": 512, "height": 512,
        "steps": 8, "cfg_scale": 5.5, "seed": seed, "n_iter": 1, "batch_size": 1,
    }


class Library(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        G.reset_for_tests()

    def tearDown(self) -> None:
        G.reset_for_tests()
        self.tmp.cleanup()

    def test_session_attach_labels_and_library_filters(self):
        first = G.store(self.root, _png(), _settings("un phare rouge", 7))
        second = G.store(self.root, _png(), _settings("une lanterne bleue", 9, "other.safetensors [efgh]"))
        created = L.create_session(self.root, {"name": "Nuit", "prompt": "un phare rouge", "settings": _settings("un phare rouge", 7),
                                              "continuity": {"character": "la gardienne", "setting": "le phare", "palette": "rouge et bleu", "light": "nuit", "camera": "35 mm"}})
        self.assertEqual(created[0], 200, created)
        session = created[1]["session"]
        self.assertEqual(session["continuity"]["camera"], "35 mm")
        updated = L.update_session(self.root, {"id": session["id"], "continuity": {"character": "la gardienne", "setting": "la côte", "palette": "", "light": "", "camera": ""}})
        self.assertEqual((updated[0], updated[1]["session"]["continuity"]["setting"]), (200, "la côte"))
        self.assertEqual(L.update_session(self.root, {"id": session["id"], "continuity": {"unknown": "x"}})[0], 400)
        self.assertEqual(L.update_session(self.root, {"id": session["id"], "continuity": {"camera": "x" * 201}})[0], 400)
        attached = L.attach(self.root, {"action": "attach", "id": session["id"], "image_ids": [first["id"], second["id"]]})
        self.assertEqual(attached[0], 200, attached)
        self.assertEqual(L.set_labels(self.root, {"id": first["id"], "tags": ["portrait", "rouge"], "collection": "nuit"})[0], 200)
        rows = L.library_page(self.root, {"tag": ["portrait"], "session": [session["id"]]})
        self.assertEqual([row["id"] for row in rows["images"]], [first["id"]])
        self.assertEqual(rows["images"][0]["labels"]["collection"], "nuit")
        self.assertEqual(L.library_page(self.root, {"q": ["lanterne"]})["total"], 1)
        self.assertEqual(L.library_page(self.root, {"model": ["other"]})["total"], 1)
        self.assertEqual(L.library_page(self.root, {"seed": ["7"]})["total"], 1)
        self.assertEqual(L.library_page(self.root, {"view": ["trash"]})["total"], 0)

    def test_family_follows_parent_without_private_content(self):
        parent = G.store(self.root, _png(), _settings())
        child = G.store(self.root, _png(), _settings())
        self.assertEqual(L.set_labels(self.root, {"id": child["id"], "parent": parent["id"]})[0], 200)
        status, family = L.family(self.root, child["id"])
        self.assertEqual(status, 200)
        self.assertEqual([node["id"] for node in family["nodes"]], [parent["id"], child["id"]])
        self.assertEqual(family["nodes"][0]["relation"], "branche")
        self.assertEqual(family["nodes"][1]["relation"], "image")

    def test_private_or_unknown_ids_never_enter_a_session(self):
        session = L.create_session(self.root, {"name": "Privé", "prompt": "x"})[1]["session"]
        status, payload = L.attach(self.root, {"action": "attach", "id": session["id"], "image_ids": ["img-" + "ab" * 12]})
        self.assertEqual(status, 404, payload)
        status, _ = L.set_labels(self.root, {"id": "img-" + "ab" * 12, "tags": ["x"]})
        self.assertEqual(status, 404)

    def test_malformed_library_file_is_preserved(self):
        image = G.store(self.root, _png(), _settings())
        path = self.root / ".hq-forge" / "library.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("{not json", encoding="utf-8")
        status, _ = L.set_labels(self.root, {"id": image["id"], "tags": ["x"]})
        self.assertEqual(status, 409)
        self.assertEqual(path.read_text(encoding="utf-8"), "{not json")


class Outpaint(unittest.TestCase):
    def test_expands_canvas_and_masks_only_new_border(self):
        source = _png(512, 512)
        expanded = I._outpaint_canvas(source, {"left": 64, "right": 64, "top": 0, "bottom": 0})
        self.assertIsNotNone(expanded)
        png, mask, size, edges = expanded
        self.assertEqual(size, (640, 512))
        self.assertEqual(edges, {"left": 64, "right": 64, "top": 0, "bottom": 0})
        with Image.open(io.BytesIO(png)) as image:
            self.assertEqual(image.size, (640, 512))
        with Image.open(io.BytesIO(mask)) as image:
            self.assertEqual(image.getpixel((2, 200)), 255)
            self.assertEqual(image.getpixel((320, 200)), 0)

    def test_refuses_bad_edges_and_too_large_result(self):
        source = _png(512, 512)
        self.assertIsNone(I._outpaint_canvas(source, {"left": 63, "right": 0, "top": 0, "bottom": 0}))
        self.assertIsNone(I._outpaint_canvas(source, {"left": 0, "right": 0, "top": 0, "bottom": 0}))
        self.assertIsNone(I._outpaint_canvas(source, {"left": 1024, "right": 1024, "top": 0, "bottom": 0}))


if __name__ == "__main__":
    unittest.main()
