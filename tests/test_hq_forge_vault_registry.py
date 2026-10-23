"""V1.1: the plain multi-vault registry accepts only the allowed fields and values."""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_forge_vault_registry as R


def entry(**over):
    base = {"id": "vlt-0123456789abcdef", "label": "Voyages", "glyph": "lune", "colour": "bleu",
            "discret": False, "order": 0, "created": "2026-10-23", "last_used_day": None}
    base.update(over)
    return base


def reg(*entries, legacy=None):
    return {"version": 1, "legacy": legacy, "vaults": list(entries)}


class RegistryTests(unittest.TestCase):
    def test_vid_is_random_and_shaped(self):
        ids = {R.new_vid() for _ in range(50)}
        self.assertEqual(len(ids), 50)
        for vid in ids:
            self.assertRegex(vid, r"^vlt-[0-9a-f]{16}$")

    def test_valid_round_trip(self):
        data = reg(entry(), entry(id="vlt-fedcba9876543210", label=None, discret=True, order=1), legacy="vlt-0123456789abcdef")
        self.assertEqual(R.parse(R.dump(data)), data)

    def test_only_allowed_fields(self):
        for bad in (entry(extra=1), {k: v for k, v in entry().items() if k != "order"}):
            with self.assertRaises(R.RegistryError):
                R.validate(reg(bad))
        with self.assertRaises(R.RegistryError):
            R.validate({**reg(entry()), "note": "x"})

    def test_rejects_tampered_values(self):
        cases = [
            entry(id="vlt-XYZ"), entry(id="../vlt-0123456789abcdef"), entry(id="vlt-0123456789abcdef/../x"),
            entry(glyph="crane"), entry(colour="#ff0000"), entry(label=""), entry(label="x" * 41),
            entry(label="a\u0000b"), entry(label="<b>"), entry(label=None), entry(discret="yes"),
            entry(discret=True), entry(order=-1), entry(order=True), entry(order=1000), entry(created="2026-13-01"),
            entry(created=None), entry(last_used_day="hier"),
        ]
        for bad in cases:
            with self.subTest(bad=bad), self.assertRaises(R.RegistryError):
                R.validate(reg(bad))

    def test_discret_name_never_in_the_clear(self):
        with self.assertRaises(R.RegistryError):
            R.validate(reg(entry(discret=True, label="Secret")))

    def test_duplicates_unknown_legacy_and_too_many(self):
        with self.assertRaises(R.RegistryError):
            R.validate(reg(entry(), entry(order=1)))
        with self.assertRaises(R.RegistryError):
            R.validate(reg(entry(), legacy="vlt-1111111111111111"))
        many = [entry(id="vlt-%016x" % i, order=i) for i in range(R.MAX_VAULTS + 1)]
        with self.assertRaises(R.RegistryError):
            R.validate(reg(*many))

    def test_corrupt_bytes(self):
        for raw in (b"", b"{", b"\xff\xfe", json.dumps([1]).encode(), b" " * (R.MAX_BYTES + 1),
                    json.dumps({"version": 2, "legacy": None, "vaults": []}).encode()):
            with self.subTest(raw=raw[:20]), self.assertRaises(R.RegistryError):
                R.parse(raw)

    def test_error_carries_no_detail(self):
        try:
            R.validate(reg(entry(label="x" * 99)))
        except R.RegistryError as exc:
            self.assertEqual(str(exc), "registry")
            self.assertEqual(exc.code, "registry")

    def test_make_entry(self):
        made = R.make_entry("vlt-0123456789abcdef", label="  Famille ", glyph="coeur", colour="rose", discret=False, order=2)
        self.assertEqual(made["label"], "Famille")
        hidden = R.make_entry("vlt-0123456789abcdef", label="Secret", glyph="coeur", colour="rose", discret=True, order=2)
        self.assertIsNone(hidden["label"])
        for kw in ({"label": ""}, {"glyph": "x"}, {"colour": "x"}, {"discret": 1}, {"order": -3}):
            args = {"label": "A", "glyph": "lune", "colour": "bleu", "discret": False, "order": 0, **kw}
            with self.subTest(kw=kw), self.assertRaises(ValueError):
                R.make_entry("vlt-0123456789abcdef", **args)


if __name__ == "__main__":
    unittest.main()