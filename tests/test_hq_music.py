"""Standalone tests; use the real hq_state.py when running inside Transfert.
The tiny fallback below reproduces the required hq_state interface only.
"""
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
try:
    import hq_state  # noqa: F401 -- real Transfert module in the target repository
except ModuleNotFoundError:
    locks: dict[str, threading.RLock] = {}
    def path_lock(path):
        key = str(path)
        locks.setdefault(key, threading.RLock())
        return locks[key]
    def write_json_atomic(path, data):
        path = Path(path)
        with path_lock(path):
            if path.exists():
                json.loads(path.read_text(encoding="utf8"))
            temp = Path(str(path) + ".tmp")
            temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf8")
            os.replace(temp, path)
    sys.modules["hq_state"] = types.SimpleNamespace(path_lock=path_lock, write_json_atomic=write_json_atomic)

import hq_music


class MusicTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        hq_music.bind(root=self.temp.name)

    def tearDown(self):
        hq_music.reset_for_tests()
        self.temp.cleanup()

    def test_get_creates_no_state(self):
        status, data = hq_music.http_get("/api/music/profile")
        self.assertEqual(status, 200)
        self.assertEqual(data["profile"]["favorite_artists"], [])
        self.assertFalse((Path(self.temp.name) / ".hq-music").exists())

    def test_update_and_query(self):
        status, data = hq_music.http_post("/api/music/profile", {"favorite_artists": ["HEALTH", "health", "Sabaton"], "preferred_genres": ["Industrial"]})
        self.assertEqual(status, 200)
        self.assertEqual(data["profile"]["favorite_artists"], ["HEALTH", "Sabaton"])
        suggestion = hq_music.discovery_query(year=2027)
        self.assertIn("HEALTH", suggestion["query"])
        self.assertIn("2027", suggestion["query"])

    def test_invalid_update_preserves_data(self):
        hq_music.update_preferences({"favorite_artists": ["Badflower"]})
        status, body = hq_music.http_post("/api/music/profile", {"favorite_artists": "bad"})
        self.assertEqual(status, 400)
        self.assertEqual(hq_music.get_profile()["favorite_artists"], ["Badflower"])
        self.assertFalse(body["ok"])

    def test_discovery_dedup_and_status(self):
        sample = {"title": "Example track", "artist": "Example artist", "source_url": "https://example.org/a", "confidence": .7}
        status, data = hq_music.http_post("/api/music/discoveries", {"items": [sample, sample]})
        self.assertEqual(status, 200)
        self.assertEqual(len(data["added"]), 1)
        song_id = data["added"][0]["id"]
        status, updated = hq_music.http_post("/api/music/discovery-status", {"id": song_id, "status": "saved"})
        self.assertEqual(status, 200)
        self.assertEqual(updated["discovery"]["status"], "saved")
        self.assertEqual(len(hq_music.get_discoveries()), 1)

    def test_no_leaked_credentials_in_state(self):
        status, body = hq_music.http_post("/api/music/profile", {"spotify_access_token": "SECRET"})
        self.assertEqual(status, 400)
        self.assertFalse(body["ok"])
        self.assertFalse((Path(self.temp.name) / ".hq-music").exists())

    def test_corrupt_file_is_preserved(self):
        folder = Path(self.temp.name) / ".hq-music"
        folder.mkdir()
        file = folder / "profile.json"
        file.write_text("{NOT VALID JSON", encoding="utf8")
        status, result = hq_music.http_post("/api/music/profile", {"favorite_artists": ["A"]})
        self.assertEqual(status, 503)
        self.assertEqual(file.read_text(encoding="utf8"), "{NOT VALID JSON")
        self.assertEqual(result["code"], "storage_error")

    def test_malformed_status_is_rejected_not_server_error(self):
        status, result = hq_music.http_post("/api/music/discovery-status", {"id": [], "status": []})
        self.assertEqual(status, 400)
        self.assertFalse(result["ok"])

    def test_bad_source_url_does_not_save(self):
        status, result = hq_music.http_post("/api/music/discoveries", {"items": [{"title": "a", "artist": "b", "source_url": "javascript:alert(1)"}]})
        self.assertEqual(status, 400)
        self.assertFalse(result["ok"])
        self.assertFalse((Path(self.temp.name) / ".hq-music").exists())

    def test_feedback(self):
        result = hq_music.record_feedback("Gloryhammer", "Example", True)
        self.assertTrue(result["liked"])
        self.assertEqual(len(hq_music.get_profile()["feedback_history"]), 1)

    def test_smtc_portable_unavailable(self):
        import hq_music_smtc
        if os.name != "nt":
            self.assertFalse(hq_music_smtc.get_now_playing()["available"])


if __name__ == "__main__":
    unittest.main()
