"""DJ Musica episode export (one MP3, chapters, cache protection) and Rembobiner text search."""
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import hq_music
import hq_music_dj as dj
import hq_music_dj_archive as archive
import hq_music_dj_export as export
import hq_musica


def tone(path: Path, seconds: float = 1.0) -> Path:
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}",
                    "-codec:a", "libmp3lame", "-q:a", "4", str(path)], check=True)
    return path


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not installed")
class ExportBase(unittest.TestCase):
    episode_id = "abc123def456"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(hq_music.reset_for_tests)
        hq_music.bind(root=self.tmp.name)
        hq_musica.bind(root=self.tmp.name)
        self.cache = dj._cache_dir()  # <root>/.hq-music/dj-cache
        self.drops = []
        for i in range(4):
            name = "drop-" + f"{i:020d}" + ".mp3"
            tone(self.cache / name)
            self.drops.append(name)
        self.segments = [
            {"id": "s1", "show": "dj", "title": "Ouverture", "theme": "synthwave", "intro": "Bienvenue dans la nuit",
             "intro_drop": self.drops[0], "guest": None, "premiere_uris": [], "joke": None,
             "tracks": [{"uri": "spotify:track:1", "name": "Song One", "artists": ["Artist One"], "drop": self.drops[1],
                         "line": "Un synthé qui gratte", "pool": "top"}]},
            {"id": "s2", "show": "dj", "title": "Montée", "theme": "rock", "intro": "Deuxième salve",
             "intro_drop": self.drops[2], "premiere_uris": [], "joke": None,
             "guest": {"who": "else", "line": "Coucou Maître", "drop": None},
             "tracks": [{"uri": "spotify:track:2", "name": "Song Two", "artists": ["Artist Two"], "drop": self.drops[3],
                         "line": None, "pool": "top"}]},
        ]
        for segment in self.segments:
            archive.record(self.episode_id, segment)

    def wait_job(self, timeout=60.0):
        end = time.time() + timeout
        while time.time() < end:
            job = export.view()["job"]
            if not job.get("running"):
                return job
            time.sleep(0.05)
        self.fail("export job did not finish")


class ExportTests(ExportBase):
    def test_one_episode_becomes_one_mp3_with_chapters(self):
        entry = export.export_episode(self.episode_id)
        self.assertTrue((self.cache / entry["file"]).is_file())
        self.assertEqual(entry["drops"], 4)  # intro, track, intro, track (the guest has no recorded line here)
        self.assertEqual([c["title"] for c in entry["chapters"]], ["Ouverture", "Song One", "Montée", "Song Two"])
        self.assertEqual(entry["chapters"][0]["at"], 0)
        self.assertGreaterEqual(entry["seconds"], 4)
        self.assertEqual(dj.drop_path(entry["file"]).name, entry["file"])  # served by the DJ audio route

    def test_the_export_is_reused_and_the_pruning_spares_it(self):
        first = export.export_episode(self.episode_id)
        again = export.export_episode(self.episode_id)
        self.assertEqual(first["file"], again["file"])
        self.assertIn(first["file"], export.drop_names())
        with mock.patch.object(dj, "CACHE_MAX_BYTES", 1):
            dj._prune_cache(keep=10, force=True)
        self.assertTrue((self.cache / first["file"]).is_file())  # an export is never pruned away

    def test_unknown_episode_is_a_404(self):
        with self.assertRaises(dj.DjError) as caught:
            export.export_episode("nope")
        self.assertEqual(caught.exception.status, 404)

    def test_the_job_runs_in_the_background(self):
        out = export.begin(self.episode_id)
        self.assertTrue(out["started"])
        job = self.wait_job()
        self.assertIsNone(job["error"])
        self.assertEqual(job["entry"]["episode"], self.episode_id)
        self.assertTrue(any(e["file"] == job["entry"]["file"] for e in export.view()["exports"]))


class SearchTests(ExportBase):
    def test_search_matches_a_line_a_track_and_a_title(self):
        by_line = export.search("synthé")
        self.assertEqual(by_line["count"], 1)
        self.assertEqual(by_line["results"][0]["id"], self.episode_id)
        self.assertEqual(by_line["results"][0]["matches"][0]["kind"], "track")
        self.assertTrue(export.search("artist two")["count"])
        self.assertTrue(export.search("montée")["count"])

    def test_search_needs_every_word_and_ignores_an_empty_query(self):
        self.assertEqual(export.search("")["count"], 0)
        self.assertEqual(export.search("synthé balalaika")["count"], 0)

    def test_search_route_reads_the_term_from_the_body(self):
        # A GET cannot carry it: the bridge hands the handler a query-less path.
        code, out = dj.http_post("/api/musica/dj/archive/search", {"q": "artist one"})
        self.assertEqual(code, 200)
        self.assertEqual(out["count"], 1)
        self.assertEqual(dj.http_post("/api/musica/dj/archive/search", {})[1]["count"], 0)

    def test_export_routes(self):
        code, out = dj.http_post("/api/musica/dj/archive/export", {"id": self.episode_id})
        self.assertEqual(code, 202)
        self.assertTrue(out["started"])
        job = self.wait_job()
        self.assertIsNone(job["error"])
        code, view = dj.http_get("/api/musica/dj/archive/export")
        self.assertEqual(code, 200)
        self.assertTrue(view["exports"])

    def test_export_route_refuses_an_unknown_episode(self):
        code, out = dj.http_post("/api/musica/dj/archive/export", {"id": "missing"})
        self.assertEqual(code, 404)
        self.assertEqual(out["code"], "not_found")


if __name__ == "__main__":
    unittest.main()
