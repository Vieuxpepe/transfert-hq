"""Forge preset store. Temp directory only. No vault and no Forge process."""

from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))

import hq_forge_presets as P  # noqa: E402


def sample(**overrides) -> dict:
    data = {
        "name": "Rapide",
        "kind": "technical",
        "prompt": "ne pas garder",
        "negative_prompt": "flou",
        "checkpoint": "example.safetensors [abcd]",
        "sampler_name": "Euler a",
        "scheduler": "automatic",
        "width": 512,
        "height": 512,
        "steps": 20,
        "cfg_scale": 7,
        "seed": -1,
        "n_iter": 1,
        "batch_size": 1,
    }
    data.update(overrides)
    return data


class PresetStore(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="forge-presets-"))

    def tearDown(self) -> None:
        for child in self.tmp.rglob("*"):
            if child.is_file():
                child.unlink()
        for child in sorted(self.tmp.rglob("*"), reverse=True):
            if child.is_dir():
                child.rmdir()
        self.tmp.rmdir()

    def test_missing_file_is_an_empty_list(self) -> None:
        payload = P.list_presets(self.tmp)
        self.assertEqual(payload["storage"], "ready")
        self.assertEqual(payload["presets"], [])
        self.assertFalse((self.tmp / ".hq-forge" / "presets.json").exists())

    def test_technical_preset_discards_the_positive_prompt(self) -> None:
        status, payload = P.create_preset(self.tmp, sample())
        self.assertEqual(status, 200)
        stored = payload["presets"][0]
        self.assertEqual(stored["prompt"], "")
        self.assertFalse(stored["include_prompt"])
        self.assertEqual(stored["negative_prompt"], "flou")
        self.assertNotIn("recovery_key", json.dumps(payload))
        again = P.list_presets(self.tmp)
        self.assertEqual(again["presets"][0]["id"], stored["id"])

    def test_creative_preset_keeps_the_positive_prompt(self) -> None:
        status, payload = P.create_preset(self.tmp, sample(kind="creative", name="Phare", prompt="un phare rouge"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["presets"][0]["prompt"], "un phare rouge")
        self.assertTrue(payload["presets"][0]["include_prompt"])

    def test_update_rename_duplicate_and_delete(self) -> None:
        _status, created = P.create_preset(self.tmp, sample())
        ident = created["presets"][0]["id"]
        status, updated = P.update_preset(self.tmp, sample(id=ident, steps=28, prompt="encore secret"))
        self.assertEqual(status, 200)
        self.assertEqual(updated["presets"][0]["steps"], 28)
        self.assertEqual(updated["presets"][0]["prompt"], "")
        status, renamed = P.rename_preset(self.tmp, {"id": ident, "name": "Soigné"})
        self.assertEqual(status, 200)
        self.assertEqual(renamed["presets"][0]["name"], "Soigné")
        status, copied = P.duplicate_preset(self.tmp, {"id": ident})
        self.assertEqual(status, 200)
        self.assertEqual(len(copied["presets"]), 2)
        self.assertNotEqual(copied["presets"][1]["id"], ident)
        status, removed = P.delete_preset(self.tmp, {"id": ident})
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in removed["presets"]], [copied["presets"][1]["id"]])

    def test_duplicate_name_is_rejected(self) -> None:
        P.create_preset(self.tmp, sample())
        status, payload = P.create_preset(self.tmp, sample(prompt="autre"))
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "duplicate")

    def test_malformed_file_is_not_replaced(self) -> None:
        path = self.tmp / ".hq-forge"
        path.mkdir()
        target = path / "presets.json"
        target.write_text("{pas du json", encoding="utf-8")
        listed = P.list_presets(self.tmp)
        self.assertEqual(listed["storage"], "malformed")
        self.assertEqual(listed["presets"], [])
        status, payload = P.create_preset(self.tmp, sample())
        self.assertEqual(status, 409)
        self.assertEqual(payload["error"], "malformed")
        self.assertEqual(target.read_text(encoding="utf-8"), "{pas du json")

    def test_failed_replace_keeps_the_previous_file(self) -> None:
        P.create_preset(self.tmp, sample())
        target = self.tmp / ".hq-forge" / "presets.json"
        before = target.read_bytes()
        with mock.patch("hq_forge_presets.os.replace", side_effect=OSError("disk")):
            with self.assertRaises(OSError):
                P.create_preset(self.tmp, sample(name="Autre"))
        self.assertEqual(target.read_bytes(), before)
        self.assertFalse((self.tmp / ".hq-forge" / "presets.json.partial").exists())

    def test_import_rejects_vault_material_and_assigns_new_ids(self) -> None:
        status, payload = P.import_presets(self.tmp, {"presets": [sample(recovery_key="secret")]})
        self.assertEqual(status, 400)
        self.assertFalse((self.tmp / ".hq-forge" / "presets.json").exists())
        status, payload = P.import_presets(self.tmp, {"version": 1, "presets": [sample(name="Importé", kind="creative", prompt="phare")]})
        self.assertEqual(status, 200)
        self.assertTrue(payload["presets"][0]["id"].startswith("preset-"))
        self.assertEqual(payload["presets"][0]["prompt"], "phare")

    def test_invalid_dimensions_are_rejected(self) -> None:
        status, payload = P.create_preset(self.tmp, sample(width=513))
        self.assertEqual(status, 400)
        self.assertEqual(payload["error"], "validation")

    def test_multiline_prompts_round_trip_without_rewriting_whitespace(self) -> None:
        positive = "  first line  \r\nsecond line\n"
        negative = "blur\r\nwatermark  "
        status, created = P.create_preset(self.tmp, sample(kind="creative", name="Lignes", prompt=positive, negative_prompt=negative))
        self.assertEqual(status, 200)
        stored = created["presets"][0]
        self.assertEqual(stored["prompt"], positive)
        self.assertEqual(stored["negative_prompt"], negative)
        ident = stored["id"]
        revised_prompt = "alpha  beta\r\n\ngamma  "
        revised_negative = "une\ndeux\r\ntrois"
        status, updated = P.update_preset(self.tmp, sample(id=ident, prompt=revised_prompt, negative_prompt=revised_negative))
        self.assertEqual(status, 200)
        self.assertEqual(updated["presets"][0]["prompt"], revised_prompt)
        self.assertEqual(updated["presets"][0]["negative_prompt"], revised_negative)
        raw = json.loads((self.tmp / ".hq-forge" / "presets.json").read_text(encoding="utf-8"))
        self.assertEqual(raw["presets"][0]["prompt"], revised_prompt)
        reloaded = P.list_presets(self.tmp)
        self.assertEqual(reloaded["presets"][0]["prompt"], revised_prompt)
        self.assertEqual(reloaded["presets"][0]["negative_prompt"], revised_negative)
        exported = {"version": reloaded["version"], "presets": reloaded["presets"]}
        other = Path(tempfile.mkdtemp(prefix="forge-presets-import-"))
        try:
            status, imported = P.import_presets(other, exported)
            self.assertEqual(status, 200)
            self.assertNotEqual(imported["presets"][0]["id"], ident)
            again = P.list_presets(other)
            self.assertEqual(again["presets"][0]["prompt"], revised_prompt)
            self.assertEqual(again["presets"][0]["negative_prompt"], revised_negative)
        finally:
            for child in other.rglob("*"):
                if child.is_file():
                    child.unlink()
            for child in sorted(other.rglob("*"), reverse=True):
                if child.is_dir():
                    child.rmdir()
            other.rmdir()

    def test_technical_and_creative_keep_multiline_negative_prompts(self) -> None:
        technical_negative = "blur\nwatermark"
        status, technical = P.create_preset(self.tmp, sample(prompt="first line\nsecond line", negative_prompt=technical_negative))
        self.assertEqual(status, 200)
        self.assertEqual(technical["presets"][0]["prompt"], "")
        self.assertEqual(technical["presets"][0]["negative_prompt"], technical_negative)
        creative_negative = "flou\r\ntexte"
        status, creative = P.create_preset(
            self.tmp, sample(kind="creative", name="Créatif", prompt="première\ndeuxième", negative_prompt=creative_negative)
        )
        self.assertEqual(status, 200)
        self.assertEqual(creative["presets"][1]["prompt"], "première\ndeuxième")
        self.assertEqual(creative["presets"][1]["negative_prompt"], creative_negative)

    def test_prompts_reject_nul_and_unsafe_controls_but_names_stay_strict(self) -> None:
        for value in ("\x00", "a\x00b", "\x01", "line\x1bmore", "\x7f", "\x85"):
            status, _payload = P.create_preset(self.tmp, sample(kind="creative", name="Contrôle", prompt=value))
            self.assertEqual(status, 400, value)
            status, _payload = P.create_preset(self.tmp, sample(name="Négatif", negative_prompt=value))
            self.assertEqual(status, 400, value)
        self.assertFalse((self.tmp / ".hq-forge" / "presets.json").exists())
        for field, value in (
            ("name", "Nom\nligne"),
            ("checkpoint", "model\rname"),
            ("sampler_name", "Euler\na"),
            ("scheduler", "auto\tmatic"),
        ):
            status, _payload = P.create_preset(self.tmp, sample(**{field: value}))
            self.assertEqual(status, 400, field)
        status, payload = P.create_preset(self.tmp, sample(kind="creative", name="Tabulation", prompt="a\tb"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["presets"][0]["prompt"], "a\tb")

    def test_prompt_length_counts_line_breaks_and_does_not_truncate(self) -> None:
        status, payload = P.create_preset(self.tmp, sample(kind="creative", name="Pile", prompt=("x" * 1999) + "\n"))
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["presets"][0]["prompt"]), 2000)
        status, _payload = P.create_preset(self.tmp, sample(kind="creative", name="Trop", prompt=("x" * 2000) + "\n"))
        self.assertEqual(status, 400)
        status, payload = P.update_preset(self.tmp, sample(id=payload["presets"][0]["id"], negative_prompt=("y" * 998) + "\r\n"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["presets"][0]["negative_prompt"], ("y" * 998) + "\r\n")
        ident = payload["presets"][0]["id"]
        before = (self.tmp / ".hq-forge" / "presets.json").read_bytes()
        status, _payload = P.update_preset(self.tmp, sample(id=ident, negative_prompt=("y" * 999) + "\r\n"))
        self.assertEqual(status, 400)
        status, _payload = P.update_preset(self.tmp, sample(id=ident, prompt="x" * 2001))
        self.assertEqual(status, 400)
        self.assertEqual((self.tmp / ".hq-forge" / "presets.json").read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
