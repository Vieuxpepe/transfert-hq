"""Text encoding guard: no lost accents in what HQ serves.

A script-based write through a non-UTF-8 pipe turns every accented letter into a literal '?'
(0x3F) - not U+FFFD and not 'A-tilde' mojibake - so older checks that looked only for those missed it.
This scans the UI sources for U+FFFD, classic mojibake, and '?' wedged between letters, with a short
allowlist for real code ('?name=' query strings, 'html?' / 'ya?ml' regexes, a deliberate test name)."""

from __future__ import annotations

import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LETTER = "A-Za-z\u00c0-\u00ff\u0152\u0153"
WEDGED = re.compile(r"[" + LETTER + r"]\?[" + LETTER + r"]")
QUERY = re.compile(r"\?[A-Za-z_][A-Za-z0-9_]*=")
ALLOW = ("html?|", "|ya?ml|", "ya?ml")
MOJIBAKE = ("\u00c3\u00a9", "\u00c3\u00a8", "\u00c3\u00a0", "\u00e2\u20ac", "\u00c2\u00a0")


def sources() -> list[Path]:
    out = [p for p in (ROOT / "assets").iterdir()
           if p.suffix in (".js", ".css", ".html") and not p.name.startswith("vendor-") and ".min." not in p.name]
    out.append(ROOT / "iphone_bridge.py")
    out.extend(sorted(ROOT.glob("hq_*.py")))
    return out


def problems(text: str) -> list[str]:
    found = []
    for number, line in enumerate(text.splitlines(), 1):
        if "\ufffd" in line:
            found.append(f"{number}: U+FFFD")
        for bad in MOJIBAKE:
            if bad in line:
                found.append(f"{number}: mojibake {bad!r}")
        for match in WEDGED.finditer(line):
            if QUERY.match(line, match.start() + 1) or any(a in line for a in ALLOW):
                continue
            found.append(f"{number}: '?' inside a word: {line.strip()[:90]!r}")
    return found


class Encoding(unittest.TestCase):
    def test_ui_sources_keep_their_accents(self):
        report = {}
        for path in sources():
            issues = problems(path.read_bytes().decode("utf-8"))  # strict: a non-UTF-8 file fails here
            if issues:
                report[path.name] = issues[:5]
        self.assertEqual(report, {})

    def test_the_detector_catches_the_real_failure(self):
        self.assertTrue(problems("<summary>R?glages de ce coffre</summary>"))
        self.assertTrue(problems("n'appara?t"))
        self.assertTrue(problems("caf\ufffd"))
        self.assertTrue(problems("R\u00c3\u00a9glages"))
        self.assertEqual(problems('api("/api/x?limit=24&cursor=" + c)'), [])
        self.assertEqual(problems("/\\.(txt|html?|ya?ml)$/i"), [])
        self.assertEqual(problems("a?.b ?? c ? d : e"), [])

    def test_known_vault_strings_are_real_utf8(self):
        html = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8")
        for text in ("<summary>S\u00e9curit\u00e9</summary>", "Par r\u00e9cent", "<legend>Ic\u00f4ne</legend>", "n'appara\u00eet que coffre ouvert", "Enregistrer les r\u00e9glages", "Chiffr\u00e9 \u00e0 part"):
            self.assertIn(text, html)


if __name__ == "__main__":
    unittest.main()