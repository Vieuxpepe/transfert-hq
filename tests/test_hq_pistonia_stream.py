"""Pistonia's stream reader (assets/hq-pistonia-stream.js) and its wiring into the chip.

The browser side of streaming has two transports: POST .../stream (SSE) and the POST .../message fallback. The reader is
extracted so the chunk-boundary logic can be driven directly by tests/check_hq_pistonia_stream.mjs; the wiring checks
below keep the page from loading the chip without its reader, which would leave the chat unable to stream at all.
"""

import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ASSET = ROOT / "assets" / "hq-pistonia-stream.js"
CHIP = ROOT / "assets" / "hq-pistonia-chip.js"


class StreamReaderTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("node"), "node not installed")
    def test_events_survive_any_chunk_boundary(self):
        script = Path(__file__).with_name("check_hq_pistonia_stream.mjs")
        completed = subprocess.run(
            ["node", str(script)], cwd=ROOT, capture_output=True, text=True, timeout=60)
        self.assertEqual(completed.returncode, 0, completed.stderr or completed.stdout)
        self.assertIn("check_hq_pistonia_stream: ok", completed.stdout)

    def test_chip_uses_the_reader_and_keeps_a_way_back(self):
        chip = CHIP.read_text(encoding="utf-8")
        self.assertIn("win.HqPistoniaStream", chip)
        self.assertIn("new Stream.Feed()", chip)
        # An old cached chip without this file must still answer: streamTurn gives up before reading, postJSON runs.
        self.assertIn("if (!Stream || !Stream.Feed) return Promise.resolve(null);", chip)
        self.assertNotIn("function sseFrame(", chip, "the inline reader moved to hq-pistonia-stream.js")

    def test_page_loads_the_reader_before_the_chip(self):
        page = (ROOT / "iphone_bridge.py").read_text(encoding="utf-8", errors="replace")
        reader = page.find('<script src="/assets/hq-pistonia-stream.js"></script>')
        chip = page.find('<script src="/assets/hq-pistonia-chip.js"></script>')
        self.assertGreater(reader, 0, "the reader script tag is missing from the page")
        self.assertGreater(chip, 0, "the chip script tag is missing from the page")
        self.assertLess(reader, chip, "the reader must load before the chip that uses it")
        self.assertTrue(ASSET.exists(), "assets/hq-pistonia-stream.js is missing")
