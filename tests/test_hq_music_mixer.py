"""Unit tests for the local Musique DJ / mixer engine."""
from __future__ import annotations

import unittest

import hq_music_mixer as mixer


def _track(i: int, artist: str = "A", plays: int = 0):
    return {
        "id": f"t{i}",
        "uri": f"spotify:track:t{i}",
        "name": f"Track {i}",
        "artists": [artist],
        "play_count": plays,
    }


class MixerTests(unittest.TestCase):
    def test_normalize_weights(self):
        self.assertEqual(mixer.normalize_weights([40, 30, 20, 10]), [0.4, 0.3, 0.2, 0.1])
        self.assertEqual(sum(mixer.normalize_weights([0, 0, 0])), 1.0)

    def test_generate_respects_seed_and_length(self):
        sources = [
            {"id": "p1", "name": "Industrial", "weight": 40, "tracks": [_track(i, "HEALTH", plays=i) for i in range(20)]},
            {"id": "p2", "name": "Metal", "weight": 60, "tracks": [_track(100 + i, "Sabaton", plays=1) for i in range(20)]},
        ]
        a = mixer.generate_session(sources, {"length": 12, "seed": 7, "artist_window": 1})
        b = mixer.generate_session(sources, {"length": 12, "seed": 7, "artist_window": 1})
        self.assertEqual([t["id"] for t in a["tracks"]], [t["id"] for t in b["tracks"]])
        self.assertEqual(len(a["tracks"]), 12)
        self.assertTrue(all(t.get("reason") for t in a["tracks"]))

    def test_excludes_and_no_consecutive_duplicate(self):
        tracks = [_track(1, "X"), _track(2, "Y"), _track(3, "Z")]
        sources = [{"id": "p", "name": "P", "weight": 1, "tracks": tracks}]
        out = mixer.generate_session(
            sources,
            {"length": 3, "seed": 1, "exclude_track_ids": ["t2"], "artist_window": 0},
        )
        ids = [t["id"] for t in out["tracks"]]
        self.assertNotIn("t2", ids)
        for i in range(1, len(ids)):
            self.assertNotEqual(ids[i], ids[i - 1])

    def test_relax_when_strict_impossible(self):
        tracks = [_track(1, "Only"), _track(2, "Only"), _track(3, "Only")]
        sources = [{"id": "p", "name": "P", "weight": 1, "tracks": tracks}]
        out = mixer.generate_session(
            sources,
            {"length": 3, "seed": 2, "artist_window": 5, "allow_relax": True},
        )
        self.assertGreaterEqual(len(out["tracks"]), 1)
        self.assertTrue(out["compromises"] or len(out["tracks"]) <= 1)

    def test_builtin_presets(self):
        presets = mixer.list_builtin_presets()
        names = {p["name"] for p in presets}
        self.assertIn("Industrial Night", names)
        self.assertIn("Mixed Chaos", names)

    def test_empty_sources_fail(self):
        with self.assertRaises(mixer.MixerError):
            mixer.generate_session([], {"length": 5})


if __name__ == "__main__":
    unittest.main()
