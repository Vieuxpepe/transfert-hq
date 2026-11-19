"""Lecteur+ backend: shared state, tags + covers, subtitles, library limit, routes (admin + CSRF).

Offline only: a throwaway ROOT and a loopback server with a fake PIN; never the live root.
"""

from __future__ import annotations

import json
import os
import shutil
import struct
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, urlencode

import hq_lecteur as L
import iphone_bridge as B
from tests.test_media_viewer import PIN, UPLOAD_PIN, _http

JPEG = b"\xff\xd8\xff\xe0" + b"J" * 40
PNG = b"\x89PNG\r\n\x1a\n" + b"P" * 40


def syncsafe(n: int) -> bytes:
    return bytes([(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127])


def id3_frame(fid: str, payload: bytes) -> bytes:
    return fid.encode() + struct.pack(">I", len(payload)) + b"\x00\x00" + payload


def make_mp3(frames: int = 1000) -> bytes:
    body = (id3_frame("TIT2", b"\x03Ma chanson")
            + id3_frame("TPE1", b"\x03Artiste \xc3\xa9t\xc3\xa9")
            + id3_frame("TALB", b"\x00Album Un")
            + id3_frame("TRCK", b"\x003/12")
            + id3_frame("TDRC", b"\x002019-05-01")
            + id3_frame("APIC", b"\x00image/jpeg\x00\x03\x00" + JPEG))
    tag = b"ID3\x03\x00\x00" + syncsafe(len(body)) + body
    frame = b"\xff\xfb\x90\x00" + b"\x00" * 32 + b"Xing" + struct.pack(">II", 1, frames) + b"\x00" * 200
    return tag + frame


def make_flac() -> bytes:
    info = struct.pack(">HHII", 4096, 4096, 0, 0)[:10]
    packed = (44100 << 44) | (1 << 41) | (15 << 36) | 441000  # 10 s, stereo, 16 bit
    info += packed.to_bytes(8, "big") + b"\x00" * 16
    vendor = b"test"
    comments = [b"TITLE=Flac Titre", b"ARTIST=Flac Artiste", b"ALBUM=Flac Album", b"TRACKNUMBER=7/9", b"DATE=2021"]
    vc = struct.pack("<I", len(vendor)) + vendor + struct.pack("<I", len(comments))
    for c in comments:
        vc += struct.pack("<I", len(c)) + c
    mime = b"image/png"
    pic = struct.pack(">II", 3, len(mime)) + mime + struct.pack(">I", 0) + struct.pack(">IIII", 1, 1, 24, 0) + struct.pack(">I", len(PNG)) + PNG

    def block(kind: int, data: bytes, last: bool = False) -> bytes:
        return bytes([kind | (0x80 if last else 0)]) + len(data).to_bytes(3, "big") + data
    return b"fLaC" + block(0, info) + block(4, vc) + block(6, pic, True)


def mp4_box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + kind + payload


def make_m4a() -> bytes:
    def item(name: bytes, payload: bytes, dtype: int = 1) -> bytes:
        return mp4_box(name, mp4_box(b"data", struct.pack(">II", dtype, 0) + payload))
    ilst = (item(b"\xa9nam", "Titre m4a".encode()) + item(b"\xa9ART", b"Artiste m4a") + item(b"\xa9alb", b"Album m4a")
            + item(b"trkn", b"\x00\x00\x00\x05\x00\x09\x00\x00", 0) + item(b"covr", JPEG, 13))
    meta = mp4_box(b"meta", b"\x00\x00\x00\x00" + mp4_box(b"ilst", ilst))
    mvhd = mp4_box(b"mvhd", b"\x00\x00\x00\x00" + struct.pack(">IIII", 0, 0, 1000, 90000) + b"\x00" * 80)
    moov = mp4_box(b"moov", mvhd + mp4_box(b"udta", meta))
    return mp4_box(b"ftyp", b"M4A \x00\x00\x00\x00M4A mp42isom") + mp4_box(b"mdat", b"\x00" * 64) + moov


class StateTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-lecteur-state-"))
        L.bind(root=self.tmp)

    def tearDown(self):
        L.reset_for_tests()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_default_then_playlist_roundtrip(self):
        self.assertEqual(L.get_state()["playlists"], [])
        st = L.apply_op({"op": "playlist_save", "playlist": {"name": " Soir ", "items": ["Inbox/a.mp3", "Inbox/b.mp3"]}})
        pl = st["playlists"][0]
        self.assertEqual((pl["name"], pl["items"]), ("Soir", ["Inbox/a.mp3", "Inbox/b.mp3"]))
        st = L.apply_op({"op": "playlist_save", "playlist": {"id": pl["id"], "name": "Nuit", "items": ["Inbox/b.mp3"]}})
        self.assertEqual([(p["name"], p["items"]) for p in st["playlists"]], [("Nuit", ["Inbox/b.mp3"])])
        self.assertEqual(L.apply_op({"op": "playlist_delete", "id": pl["id"]})["playlists"], [])
        self.assertTrue((self.tmp / L.STATE_FOLDER / L.STATE_FILE).is_file())

    def test_paths_are_validated(self):
        for bad in ("../x.mp3", "/etc/passwd", "Inbox/../../x", "", "a//b", "a\x00b", "x" * 600, 12, None):
            with self.assertRaises(L.LecteurError, msg=repr(bad)):
                L.apply_op({"op": "favorite", "rel": bad, "on": True})
        st = L.apply_op({"op": "favorite", "rel": "Inbox\\Musique\\a.mp3", "on": True})
        self.assertEqual(st["favorites"], ["Inbox/Musique/a.mp3"])  # backslashes normalised
        self.assertEqual(L.apply_op({"op": "favorite", "rel": "Inbox/Musique/a.mp3", "on": False})["favorites"], [])

    def test_position_done_recents_prefs(self):
        st = L.apply_op({"op": "position", "rel": "Uni/v.mp4", "t": 754.2, "d": 3600})
        self.assertEqual((st["positions"]["Uni/v.mp4"]["t"], st["positions"]["Uni/v.mp4"]["done"]), (754.2, False))
        st = L.apply_op({"op": "position", "rel": "Uni/v.mp4", "done": True, "d": 3600})
        self.assertEqual((st["positions"]["Uni/v.mp4"]["t"], st["positions"]["Uni/v.mp4"]["done"]), (0.0, True))
        L.apply_op({"op": "recent", "rel": "Inbox/a.mp3"})
        st = L.apply_op({"op": "recent", "rel": "Inbox/b.mp3"})
        st = L.apply_op({"op": "recent", "rel": "Inbox/a.mp3"})
        self.assertEqual([r["rel"] for r in st["recents"]], ["Inbox/a.mp3", "Inbox/b.mp3"])
        st = L.apply_op({"op": "prefs", "prefs": {"rate": 9, "shuffle": 1, "repeat": "weird", "volume": -3}})
        self.assertEqual(st["prefs"], {"rate": 2.5, "shuffle": True, "volume": 0.0})
        self.assertEqual(L.apply_op({"op": "prefs", "prefs": {"repeat": "all"}})["prefs"]["repeat"], "all")

    def test_caps_and_garbage(self):
        for i in range(L.MAX_POSITIONS + 20):
            L.apply_op({"op": "position", "rel": f"Inbox/{i}.mp3", "t": 10, "d": 500})
        self.assertLessEqual(len(L.get_state()["positions"]), L.MAX_POSITIONS)
        for bad in ({"op": "nope"}, {"op": "playlist_save"}, {"op": "playlist_save", "playlist": {"name": " "}}, {"op": "prefs"}):
            with self.assertRaises(L.LecteurError, msg=str(bad)):
                L.apply_op(bad)
        with self.assertRaises(L.LecteurError):
            L.apply_op([1, 2])  # type: ignore[arg-type]

    def test_unreadable_state_is_preserved(self):
        folder = self.tmp / L.STATE_FOLDER
        folder.mkdir()
        (folder / L.STATE_FILE).write_text("{not json", encoding="utf-8")
        with self.assertRaises(L.LecteurError) as ctx:
            L.apply_op({"op": "favorite", "rel": "Inbox/a.mp3", "on": True})
        self.assertEqual(ctx.exception.status, 503)
        self.assertEqual((folder / L.STATE_FILE).read_text(encoding="utf-8"), "{not json")

    def test_hand_edited_state_is_coerced(self):
        folder = self.tmp / L.STATE_FOLDER
        folder.mkdir()
        (folder / L.STATE_FILE).write_text(json.dumps({"playlists": [{"id": "BAD!", "name": "x"}, 5], "favorites": ["../no", "Inbox/ok.mp3", "Inbox/ok.mp3"],
                                                       "positions": {"../x": {"t": 1}, "Inbox/p.mp3": {"t": "oops", "d": 10}}}), encoding="utf-8")
        st = L.get_state()
        self.assertEqual((st["playlists"], st["favorites"]), ([], ["Inbox/ok.mp3"]))
        self.assertEqual(list(st["positions"]), ["Inbox/p.mp3"])


class TagTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-lecteur-tags-"))

    def tearDown(self):
        L.reset_for_tests()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, name: str, data: bytes) -> Path:
        p = self.tmp / name
        p.write_bytes(data)
        return p

    def test_mp3_id3_with_cover_and_xing_duration(self):
        p = self.write("a.mp3", make_mp3())
        t = L.read_tags(p)
        self.assertEqual((t["title"], t["artist"], t["album"], t["track"], t["year"]), ("Ma chanson", "Artiste été", "Album Un", "3/12", "2019"))
        self.assertTrue(t["has_art"])
        self.assertAlmostEqual(t["duration"], 1000 * 1152 / 44100, places=1)
        art = L.read_art(p)
        self.assertEqual(art[0], "image/jpeg")
        self.assertEqual(art[1], JPEG)

    def test_flac(self):
        p = self.write("a.flac", make_flac())
        t = L.read_tags(p)
        self.assertEqual((t["title"], t["artist"], t["album"], t["track"], t["year"]), ("Flac Titre", "Flac Artiste", "Flac Album", "7", "2021"))
        self.assertAlmostEqual(t["duration"], 10.0, places=1)
        self.assertEqual(L.read_art(p), ("image/png", PNG))

    def test_m4a(self):
        p = self.write("a.m4a", make_m4a())
        t = L.read_tags(p)
        self.assertEqual((t["title"], t["artist"], t["album"], t["track"]), ("Titre m4a", "Artiste m4a", "Album m4a", "5"))
        self.assertAlmostEqual(t["duration"], 90.0, places=1)
        self.assertEqual(L.read_art(p), ("image/jpeg", JPEG))

    def test_garbage_and_art_type_comes_from_bytes(self):
        self.assertEqual(L.read_tags(self.write("junk.mp3", b"\x00" * 50)).get("title"), None)
        self.assertEqual(L.read_tags(self.write("empty.flac", b"")), {})
        self.assertEqual(L.read_tags(self.tmp / "missing.mp3"), {})
        self.assertIsNone(L.read_art(self.write("junk2.mp3", b"ID3\x03\x00\x00" + syncsafe(3) + b"abc")))
        # an HTML "cover" labelled image/jpeg is refused: only real JPEG/PNG/WebP bytes are served
        body = id3_frame("APIC", b"\x00image/jpeg\x00\x03\x00" + b"<script>alert(1)</script>")
        evil = self.write("evil.mp3", b"ID3\x03\x00\x00" + syncsafe(len(body)) + body + b"\xff\xfb\x90\x00" + b"\x00" * 100)
        self.assertIsNone(L.read_art(evil))

    def test_wav_duration(self):
        data = b"RIFF" + struct.pack("<I", 36 + 88200) + b"WAVE" + b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, 44100, 88200, 2, 16) + b"data" + struct.pack("<I", 88200) + b"\x00" * 88200
        self.assertAlmostEqual(L.read_tags(self.write("a.wav", data))["duration"], 1.0, places=2)


class SubtitleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="hq-lecteur-subs-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_srt_to_vtt(self):
        p = self.tmp / "film.srt"
        p.write_bytes("﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nSalut é\r\n\r\n2\r\n00:01:00,000 --> 00:01:02,250\r\nFin\r\n".encode("utf-8"))
        vtt = L.subtitle_vtt(p)
        self.assertTrue(vtt.startswith("WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nSalut é"))
        self.assertIn("00:01:00.000 --> 00:01:02.250", vtt)
        self.assertNotIn("\r", vtt)

    def test_vtt_passthrough_latin1_and_limits(self):
        v = self.tmp / "a.vtt"
        v.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOk\n", encoding="utf-8")
        self.assertEqual(L.subtitle_vtt(v), v.read_text(encoding="utf-8"))
        s = self.tmp / "b.srt"
        s.write_bytes("1\n00:00:01,000 --> 00:00:02,000\nCaf\xe9\n".encode("cp1252"))
        self.assertIn("Café", L.subtitle_vtt(s))
        big = self.tmp / "big.srt"
        big.write_bytes(b"x" * (L.MAX_SUB_BYTES + 1))
        with self.assertRaises(L.LecteurError):
            L.subtitle_vtt(big)
        with self.assertRaises(L.LecteurError):
            L.subtitle_vtt(self.tmp / "notes.txt")

    def test_find_subtitles(self):
        video = self.tmp / "Mon film.mp4"
        video.write_bytes(b"\x00")
        for name in ("Mon film.srt", "Mon film.fr.srt", "Mon film.en.vtt", "Autre.srt", "Mon film.txt", "Mon film2.srt"):
            (self.tmp / name).write_text("x", encoding="utf-8")
        found = {t["name"]: (t["label"], t["lang"]) for t in L.find_subtitles(video)}
        self.assertEqual(found, {"Mon film.srt": ("Sous-titres", ""), "Mon film.fr.srt": ("fr", "fr"), "Mon film.en.vtt": ("en", "en")})


class RouteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._saved = (B.ROOT, B.SESSIONS_PATH, json.loads(json.dumps(B.CONFIG)), B._HQ_BOUND)
        cls.tmp = Path(tempfile.mkdtemp(prefix="hq-lecteur-route-"))
        for folder in ("Inbox", "Uni", "Print"):
            (cls.tmp / folder).mkdir()
        B.ROOT = cls.tmp
        B.SESSIONS_PATH = cls.tmp / "bridge_sessions.json"
        B.CONFIG.update({"pin": PIN, "discord_webhook_url": "", "push_enabled": False, "daily_brief_discord": False,
                         "users": [{"name": "admin", "pin": PIN, "role": "admin"}, {"name": "phone", "pin": UPLOAD_PIN, "role": "upload"}]})
        B.bind_cc_ext()
        B.bind_hq()
        inbox = cls.tmp / "Inbox"
        (inbox / "Musique").mkdir()
        (inbox / "Musique" / "a.mp3").write_bytes(make_mp3())
        (inbox / "Musique" / "plain.mp3").write_bytes(b"\x00" * 30)
        (inbox / "Musique" / "note.txt").write_text("hello", encoding="utf-8")
        (cls.tmp / "Uni").joinpath("film.mp4").write_bytes(b"\x00" * 64)
        (cls.tmp / "Uni" / "film.fr.srt").write_text("1\n00:00:01,000 --> 00:00:02,000\nSalut\n", encoding="utf-8")
        (cls.tmp / "Uni" / "modele.obj").write_text("v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", encoding="utf-8")
        (cls.tmp / "secret.srt").write_text("outside", encoding="utf-8")
        for i in range(7):
            (cls.tmp / "Print" / f"m{i}.mp3").write_bytes(b"\x00" * 10)

        class Quiet(B.Handler):
            def log_message(self, *_args):
                pass

        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.port = cls.httpd.server_address[1]
        threading.Thread(target=cls.httpd.serve_forever, daemon=True).start()
        cls.admin = cls._login(PIN)
        cls.phone = cls._login(UPLOAD_PIN)

    @classmethod
    def _login(cls, pin):
        B._LOGIN_FAILS.clear()
        status, headers, _ = _http(cls.port, "/login", method="POST", body=urlencode({"pin": pin}).encode(),
                                   headers={"Origin": f"http://127.0.0.1:{cls.port}", "Content-Type": "application/x-www-form-urlencoded"})
        assert status == 303, status
        return headers["set-cookie"].split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        B.ROOT, B.SESSIONS_PATH, config, _hq = cls._saved
        B.CONFIG.clear()
        B.CONFIG.update(config)
        B.bind_cc_ext()
        B._HQ_BOUND = False
        L.reset_for_tests()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def get(self, path, cookie="admin"):
        return _http(self.port, path, cookie={"admin": self.admin, "phone": self.phone}.get(cookie, cookie))

    def post(self, path, payload, cookie="admin", origin=True):
        headers = {"Content-Type": "application/json"}
        if origin:
            headers["Origin"] = f"http://127.0.0.1:{self.port}"
        return _http(self.port, path, method="POST", body=json.dumps(payload).encode(), headers=headers,
                     cookie={"admin": self.admin, "phone": self.phone}.get(cookie, cookie))

    def test_auth_and_roles(self):
        paths = ("/api/lecteur/state", "/api/media/subs?rel=Uni/film.mp4", "/api/media/sub?rel=Uni/film.fr.srt",
                 "/api/media/meta?rel=Inbox/Musique/a.mp3", "/api/media/art?rel=Inbox/Musique/a.mp3")
        for path in paths:
            self.assertEqual(self.get(path, cookie="")[0], 401, path)
            self.assertEqual(self.get(path, cookie="phone")[0], 403, path)
        self.assertEqual(self.post("/api/lecteur/state", {"op": "recent", "rel": "Uni/film.mp4"}, cookie="")[0], 401)
        self.assertEqual(self.post("/api/lecteur/state", {"op": "recent", "rel": "Uni/film.mp4"}, cookie="phone")[0], 403)
        self.assertEqual(self.post("/api/media/meta", {"rels": []}, cookie="phone")[0], 403)

    def test_state_roundtrip_and_csrf(self):
        self.assertEqual(self.post("/api/lecteur/state", {"op": "recent", "rel": "Uni/film.mp4"}, origin=False)[0], 403)
        status, _h, body = self.post("/api/lecteur/state", {"op": "playlist_save", "playlist": {"name": "Test", "items": ["Uni/film.mp4"]}})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["state"]["playlists"][0]["name"], "Test")
        status, _h, body = self.get("/api/lecteur/state")
        self.assertEqual((status, json.loads(body)["state"]["playlists"][0]["items"]), (200, ["Uni/film.mp4"]))
        self.assertEqual(self.post("/api/lecteur/state", {"op": "favorite", "rel": "../../x", "on": True})[0], 400)
        self.assertEqual(self.post("/api/lecteur/state", {"op": "boom"})[0], 400)

    def test_meta_art_single_and_batch(self):
        status, _h, body = self.get("/api/media/meta?rel=" + quote("Inbox/Musique/a.mp3"))
        tags = json.loads(body)["tags"]
        self.assertEqual((status, tags["title"], tags["has_art"]), (200, "Ma chanson", True))
        status, headers, body = self.get("/api/media/art?rel=" + quote("Inbox/Musique/a.mp3"))
        self.assertEqual((status, headers["content-type"], body), (200, "image/jpeg", JPEG))
        self.assertEqual(headers["x-content-type-options"], "nosniff")
        self.assertEqual(self.get("/api/media/art?rel=" + quote("Inbox/Musique/plain.mp3"))[0], 404)
        self.assertEqual(self.get("/api/media/meta?rel=" + quote("Inbox/Musique/note.txt"))[0], 415)  # not a media type
        self.assertEqual(self.get("/api/media/meta?rel=nope.mp3")[0], 404)
        status, _h, body = self.post("/api/media/meta", {"rels": ["Inbox/Musique/a.mp3", "Inbox/Musique/note.txt", "../secret.srt", 5]})
        self.assertEqual((status, list(json.loads(body)["tags"])), (200, ["Inbox/Musique/a.mp3"]))
        self.assertEqual(self.post("/api/media/meta", {"rels": "x"})[0], 400)

    def test_subtitles(self):
        status, _h, body = self.get("/api/media/subs?rel=Uni/film.mp4")
        self.assertEqual((status, json.loads(body)["tracks"]), (200, [{"name": "film.fr.srt", "label": "fr", "lang": "fr"}]))
        self.assertEqual(json.loads(self.get("/api/media/subs?rel=Inbox/Musique/a.mp3")[2])["tracks"], [])  # audio: none
        status, headers, body = self.get("/api/media/sub?rel=Uni/film.fr.srt")
        self.assertEqual(status, 200)
        self.assertTrue(headers["content-type"].startswith("text/vtt"))
        self.assertIn(b"00:00:01.000 --> 00:00:02.000", body)
        self.assertEqual(self.get("/api/media/sub?rel=Inbox/Musique/a.mp3")[0], 415)
        self.assertEqual(self.get("/api/media/sub?rel=../secret.srt")[0], 404)  # outside the served folders

    def test_library_limit_and_new_types(self):
        status, _h, body = self.get("/api/media/library?limit=3")
        data = json.loads(body)
        self.assertEqual((status, len(data["items"]), data["truncated"]), (200, 3, True))
        self.assertGreaterEqual(data["total"], 9)
        self.assertEqual(len(json.loads(self.get("/api/media/library?limit=abc")[2])["items"]), data["total"])
        self.assertEqual(len(json.loads(self.get("/api/media/library?limit=0")[2])["items"]), 1)  # clamped to >= 1
        items = {i["rel"]: i["kind"] for i in json.loads(self.get("/api/media/library?limit=100")[2])["items"]}
        self.assertEqual(items["Uni/modele.obj"], "model")
        status, headers, _b = self.get("/media/Uni/modele.obj")
        self.assertEqual((status, headers["content-type"]), (200, "model/obj"))
        self.assertTrue(headers["content-disposition"].startswith("attachment;"))


if __name__ == "__main__":
    unittest.main()
