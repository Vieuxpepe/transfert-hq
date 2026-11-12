"""Spotify module tests with mocked HTTP — no live Spotify calls."""
from __future__ import annotations

import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import hq_spotify


class SpotifyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.cfg = {
            "spotify_client_id": "cid-test",
            "spotify_client_secret": "secret-test",
            "spotify_redirect_uri": "http://127.0.0.1:8765/api/spotify/callback",
        }
        hq_spotify.bind(root=self.temp.name, config_getter=lambda: self.cfg)

    def tearDown(self):
        hq_spotify.reset_for_tests()
        self.temp.cleanup()

    def test_status_unconfigured(self):
        hq_spotify.bind(root=self.temp.name, config_getter=lambda: {})
        status, body = hq_spotify.http_get("/api/spotify/status")
        self.assertEqual(status, 200)
        self.assertFalse(body["connected"])
        self.assertFalse(body["configured"])

    def test_begin_auth_and_state_validation(self):
        status, body = hq_spotify.http_get("/api/spotify/connect")
        self.assertEqual(status, 200)
        self.assertIn("authorize_url", body)
        self.assertIn("code_challenge", body["authorize_url"])
        bad = hq_spotify.http_get("/api/spotify/callback", {"code": ["x"], "state": ["nope"]})
        self.assertEqual(bad[0], 400)
        self.assertEqual(bad[1]["code"], "oauth_state_invalid")

    def test_complete_auth_stores_tokens_not_in_profile_path(self):
        begin = hq_spotify.begin_auth()
        token_payload = {
            "access_token": "access-AAA",
            "refresh_token": "refresh-BBB",
            "expires_in": 3600,
            "scope": hq_spotify.SCOPES,
            "token_type": "Bearer",
        }
        profile = {"id": "user1", "display_name": "Master", "email": "m@example.com", "product": "premium"}

        def fake_urlopen(req, timeout=20):
            url = getattr(req, "full_url", None) or req.get_full_url()
            class Resp:
                status = 200
                def read(self):
                    if "api/token" in url:
                        return json.dumps(token_payload).encode()
                    if url.endswith("/v1/me") or url.endswith("/me"):
                        return json.dumps(profile).encode()
                    return b"{}"
                def __enter__(self): return self
                def __exit__(self, *a): return False
            return Resp()

        with mock.patch("urllib.request.urlopen", side_effect=fake_urlopen):
            result = hq_spotify.complete_auth("auth-code", begin["state"])
        self.assertTrue(result["connected"])
        self.assertEqual(result["display_name"], "Master")
        self.assertEqual(result["email"], "m***@example.com")
        token_file = Path(self.temp.name) / ".hq-music" / "spotify_tokens.json"
        self.assertTrue(token_file.exists())
        raw = token_file.read_text(encoding="utf-8")
        self.assertIn("access-AAA", raw)
        # status must not leak raw tokens
        status = hq_spotify.status()
        dumped = json.dumps(status)
        self.assertNotIn("access-AAA", dumped)
        self.assertNotIn("refresh-BBB", dumped)

    def test_player_requires_connection(self):
        status, body = hq_spotify.http_get("/api/spotify/player")
        self.assertEqual(status, 401)
        self.assertEqual(body["code"], "spotify_not_connected")

    def test_disconnect(self):
        folder = Path(self.temp.name) / ".hq-music"
        folder.mkdir(parents=True)
        (folder / "spotify_tokens.json").write_text(json.dumps({
            "access_token": "x", "refresh_token": "y", "expires_at": 9e12, "profile": {}
        }), encoding="utf-8")
        status, body = hq_spotify.http_post("/api/spotify/disconnect", {})
        self.assertEqual(status, 200)
        self.assertFalse(body["connected"])
        self.assertFalse((folder / "spotify_tokens.json").exists())

    def test_rate_limit_maps_code(self):
        folder = Path(self.temp.name) / ".hq-music"
        folder.mkdir(parents=True)
        (folder / "spotify_tokens.json").write_text(json.dumps({
            "access_token": "x", "refresh_token": "y", "expires_at": 9e12, "profile": {}
        }), encoding="utf-8")

        import io
        import urllib.error

        def boom(req, timeout=25):
            fp = io.BytesIO(b'{"error":{"message":"slow down"}}')
            raise urllib.error.HTTPError(
                "https://api.spotify.com/v1/me/player",
                429,
                "Too Many",
                {"Retry-After": "0"},
                fp,
            )

        with mock.patch("urllib.request.urlopen", side_effect=boom):
            with mock.patch("time.sleep", return_value=None):
                status, body = hq_spotify.http_get("/api/spotify/player")
        self.assertEqual(status, 429)
        self.assertEqual(body["code"], "spotify_rate_limited")


if __name__ == "__main__":
    unittest.main()
