"""Pin reaction OGG preset to Desktop Godot v24 compressor (arcade soft 30 stereo)."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from reaction_ogg_preset import (  # noqa: E402
    BITRATE_KBPS,
    DESKTOP_COMPRESSOR_DEFAULT,
    REFERENCE_AUDIO_FILTER,
    REFERENCE_AUDIO_FILTER_SHA256,
    SAMPLE_RATE_HZ,
    audio_filter_from_desktop_compressor,
    build_audio_filter_chain,
    build_encode_argv,
    reference_audio_filter_digest,
)


class ReactionOggPresetTests(unittest.TestCase):
    def test_build_chain_matches_logged_reference(self):
        self.assertEqual(build_audio_filter_chain(), REFERENCE_AUDIO_FILTER)

    def test_reference_sha256_pin(self):
        self.assertEqual(reference_audio_filter_digest(), REFERENCE_AUDIO_FILTER_SHA256)
        self.assertEqual(
            reference_audio_filter_digest(),
            __import__("hashlib").sha256(REFERENCE_AUDIO_FILTER.encode()).hexdigest(),
        )

    def test_encode_argv_shape(self):
        cmd = build_encode_argv("ffmpeg", "in.mp3", "out.ogg")
        self.assertEqual(cmd[0], "ffmpeg")
        self.assertEqual(cmd[cmd.index("-i") + 1], "in.mp3")
        self.assertIn("-vn", cmd)
        self.assertEqual(cmd[cmd.index("-ar") + 1], str(SAMPLE_RATE_HZ))
        self.assertEqual(cmd[cmd.index("-af") + 1], REFERENCE_AUDIO_FILTER)
        self.assertEqual(cmd[cmd.index("-c:a") + 1], "libvorbis")
        self.assertEqual(cmd[cmd.index("-b:a") + 1], f"{BITRATE_KBPS}k")
        self.assertEqual(cmd[-1], "out.ogg")

    def test_desktop_compressor_stays_in_sync_when_present(self):
        if not DESKTOP_COMPRESSOR_DEFAULT.is_file():
            self.skipTest(f"Desktop compressor not found: {DESKTOP_COMPRESSOR_DEFAULT}")
        extracted = audio_filter_from_desktop_compressor()
        self.assertIsNotNone(extracted, "Could not parse filter chain from Desktop script")
        self.assertEqual(extracted, REFERENCE_AUDIO_FILTER)
        self.assertEqual(extracted, build_audio_filter_chain())


if __name__ == "__main__":
    unittest.main()
