"""Tests for Musica's deep profile fetcher and multi-dimensional taste analyzer."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import tempfile
import unittest
from unittest import mock

import hq_music
import hq_music_journal
import hq_musica
import hq_musica_profile
import hq_spotify


class MusicaProfileTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        hq_music.bind(root=self.temp.name)
        hq_spotify.bind(root=self.temp.name, config_getter=lambda: {})
        hq_musica.bind(root=self.temp.name)

    def tearDown(self):
        hq_musica.reset_for_tests()
        hq_spotify.reset_for_tests()
        hq_music.reset_for_tests()
        self.temp.cleanup()

    def _seed_local_data(self):
        now = datetime.now(timezone.utc)
        # Journal plays: morning power metal, night phonk, back-to-back co-occurrence
        tracks = []
        for i in range(6):
            t_morn = (now - timedelta(days=i)).replace(hour=13, minute=10 + i * 3)
            tracks.append({
                "uri": f"spotify:track:pm{i}",
                "name": f"Battle Hymn {i}",
                "artists": ["Gloryhammer" if i % 2 == 0 else "Sabaton"],
                "duration_ms": 290000,
                "played_at": t_morn.isoformat().replace("+00:00", "Z"),
            })
        for i in range(4):
            t_night = (now - timedelta(days=i)).replace(hour=4, minute=15 + i * 2)
            tracks.append({
                "uri": f"spotify:track:ph{i}",
                "name": f"Drift Pulse {i}",
                "artists": ["Mechagnome" if i % 2 == 0 else "ShinoBiWan"],
                "duration_ms": 115000,
                "played_at": t_night.isoformat().replace("+00:00", "Z"),
            })
        hq_music_journal.record(tracks)

        # DJ signals + steers
        hq_music._write("dj_state.json", {
            "artist_signal": {
                "gloryhammer": {"name": "Gloryhammer", "done": 8, "skipped": 0},
                "bad band": {"name": "Bad Band", "done": 0, "skipped": 6},
            },
            "pool_stats": {
                "classics": {"done": 10, "skipped": 1},
                "discovery": {"done": 2, "skipped": 8},
            },
            "steers": [{"text": "plus de power metal épique", "part": "matin"}],
        })

        # Beat grids
        hq_music._write("musica_beats.json", {
            "version": 1,
            "grids": {
                "t1": {"bpm": 168.0, "offset": 0.1, "confidence": 0.9, "source": "live"},
                "t2": {"bpm": 128.0, "offset": 0.2, "confidence": 0.9, "source": "tap"},
            },
        })

        # Taste feedback
        hq_music.update_taste({"ban": "Banned Noise"})

    def test_deep_fetch_and_multi_dimensional_analysis(self):
        self._seed_local_data()
        raw_spotify = {
            "top_artists": {
                "short": [
                    {"id": "a_glory", "name": "Gloryhammer", "genres": ["symphonic power metal", "power metal"], "popularity": 62},
                    {"id": "a_mech", "name": "Mechagnome", "genres": ["industrial metal", "darksynth"], "popularity": 34},
                ],
                "medium": [
                    {"id": "a_sab", "name": "Sabaton", "genres": ["power metal", "heavy metal"], "popularity": 74},
                ],
                "long": [
                    {"id": "a_old", "name": "Old Nostalgia", "genres": ["classic rock"], "popularity": 68},
                ],
            },
            "top_tracks": {
                "short": [
                    {"id": "t1", "uri": "spotify:track:t1", "name": "Keeper", "artists": ["Gloryhammer"], "artist_ids": ["a_glory"], "duration_ms": 310000, "year": "2023", "popularity": 58, "explicit": False},
                ],
                "medium": [],
                "long": [],
            },
            "recent": [
                {"id": "t2", "uri": "spotify:track:t2", "name": "Montagem", "artists": ["DJ Samir"], "artist_ids": ["a_samir"], "duration_ms": 105000, "year": "2025", "popularity": 45, "explicit": True},
            ],
            "saved_tracks": [
                {"id": "t3", "uri": "spotify:track:t3", "name": "DSM-V", "artists": ["HEALTH"], "artist_ids": ["a_health"], "duration_ms": 215000, "year": "2023", "popularity": 52, "explicit": True, "added_at": "2026-10-01T12:00:00Z"},
            ],
            "saved_albums": [
                {"id": "alb1", "name": "RAT WARS", "artists": ["HEALTH"], "year": "2023"},
            ],
            "playlists": [
                {"id": "p1", "uri": "spotify:playlist:p1", "name": "Training Metal", "tracks_total": 2, "tracks": [
                    {"id": "t1", "uri": "spotify:track:t1", "name": "Keeper", "artists": ["Gloryhammer"], "duration_ms": 310000},
                    {"id": "t4", "uri": "spotify:track:t4", "name": "Primo Victoria", "artists": ["Sabaton"], "duration_ms": 255000},
                ]},
                {"id": "p_skip", "uri": "spotify:playlist:ps", "name": "Musica · Keepers", "tracks_total": 1, "tracks": []},
            ],
            "enriched": [
                {"id": "a_samir", "name": "DJ Samir", "genres": ["brazilian phonk", "montagem"], "popularity": 49},
                {"id": "a_health", "name": "HEALTH", "genres": ["industrial rock", "noise pop"], "popularity": 55},
            ],
        }

        with mock.patch("hq_spotify.status", return_value={"connected": True}), \
             mock.patch("hq_spotify.playback_playlist_uri", return_value=None), \
             mock.patch("hq_spotify.top_artists", side_effect=lambda p, **kw: {"ok": True, "artists": raw_spotify["top_artists"].get(p, [])}), \
             mock.patch("hq_spotify.top_tracks", side_effect=lambda p, **kw: {"ok": True, "tracks": raw_spotify["top_tracks"].get(p, [])}), \
             mock.patch("hq_spotify.recently_played", return_value={"ok": True, "tracks": raw_spotify["recent"]}), \
             mock.patch("hq_spotify.saved_tracks", return_value={"ok": True, "tracks": raw_spotify["saved_tracks"], "next": False}), \
             mock.patch("hq_spotify.saved_albums", return_value={"ok": True, "albums": raw_spotify["saved_albums"], "next": False}), \
             mock.patch("hq_spotify.followed_artists", side_effect=hq_spotify.SpotifyError("Forbidden", 403, "spotify_unavailable_endpoint")), \
             mock.patch("hq_spotify.list_playlists", return_value={"ok": True, "items": raw_spotify["playlists"]}), \
             mock.patch("hq_spotify.collect_playlist_tracks", side_effect=lambda pid, **kw: raw_spotify["playlists"][0]["tracks"] if pid == "p1" else []), \
             mock.patch("hq_spotify.get_artists", return_value=raw_spotify["enriched"]), \
             mock.patch("hq_musica_profile._fetch_public_artist_meta", return_value=None), \
             mock.patch("hq_musica_profile._fetch_lyrics_sample", return_value=None):
            with mock.patch("hq_ai.generate", return_value=(json.dumps({
                "narrative_summary": "The Master fuses epic theatrical power metal with high-velocity phonk and industrial electronics.",
                "psychological_threads": ["High-energy adrenaline", "Theatrical precision"],
                "blind_spots_and_bridges": ["Electronicore (Electric Callboy)", "Cyberpunk Darksynth"],
                "mood_rules": {"matin": "Power metal drive", "nuit": "Dark industrial and slowed phonk"},
            }), "gemini-test")):
                result = hq_musica_profile.run_full_pipeline(deep=True, force=True, synthesize=True, sync_preferences=True)

        self.assertTrue(result["ok"])
        dossier = result["analysis"]
        self.assertTrue(dossier["source_coverage"]["spotify_connected"])
        self.assertEqual(dossier["source_coverage"]["spotify_playlists_scanned"], 1)  # Musica · Keepers excluded

        names = [a["name"] for a in dossier["artist_affinities"]]
        self.assertIn("Gloryhammer", names)
        self.assertIn("HEALTH", names)
        self.assertIn("DJ Samir", names)
        self.assertNotIn("Bad Band", names)
        self.assertNotIn("Banned Noise", names)

        cooling_names = [a["name"] for a in dossier["cooling_and_rejected"]]
        self.assertIn("Bad Band", cooling_names)
        self.assertIn("Banned Noise", cooling_names)

        # Macro families & genres
        families = [f["family"] for f in dossier["genre_profile"]["macro_families"]]
        self.assertIn("Metal & Heavy", families)
        self.assertIn("Phonk & Drift", families)

        # Constellations, circadian, acoustic, playlists, AI synthesis
        self.assertGreaterEqual(len(dossier["sonic_constellations"]), 1)
        self.assertGreater(dossier["circadian_profile"]["active_days"], 0)
        self.assertEqual(dossier["acoustic_fingerprint"]["bpm_profile"]["measured_tracks"], 2)
        self.assertEqual(dossier["playlist_archetypes"][0]["archetype"], "Workout / Training")
        self.assertIn("narrative_summary", dossier["ai_synthesis"])

        # Synced into hq_music.get_profile()
        synced = hq_music.get_profile()
        self.assertIn("Gloryhammer", synced["favorite_artists"])
        self.assertTrue(any("power metal" in g for g in synced["preferred_genres"]))

        # Prompt dossier & tool query
        prompt_text = hq_musica_profile.prompt_dossier()
        self.assertIn("MASTER DEEP TASTE DOSSIER", prompt_text)
        self.assertIn("Gloryhammer", prompt_text)

        tool_res = hq_musica._run_tool("my_taste_profile", {"section": "genres"})
        self.assertTrue(tool_res["ok"])
        self.assertEqual(tool_res["section"], "genres")

    def test_privacy_disables_fetch_analysis_and_tool(self):
        self._seed_local_data()
        hq_music.update_taste({"history_sharing": False})

        raw = hq_musica_profile.fetch_raw_profile(deep=True, force=True)
        self.assertEqual(raw.get("skipped"), "history_sharing_disabled")
        self.assertEqual(hq_musica_profile.prompt_dossier(), "")

        status, body = hq_musica.http_get("/api/musica/profile")
        self.assertEqual(status, 200)
        self.assertFalse(body["history_sharing"])
        self.assertIsNone(body["analysis"])

        with self.assertRaises(hq_musica.MusicaError):
            hq_musica._run_tool("my_taste_profile", {"section": "overview"})

    def test_rate_limit_preserves_partial_raw_and_http_routes(self):
        self._seed_local_data()
        with mock.patch("hq_spotify.status", return_value={"connected": True}), \
             mock.patch("hq_spotify.top_artists", side_effect=hq_spotify.SpotifyError("slow", 429, "spotify_rate_limited", retry_after=30)), \
             mock.patch("hq_musica_profile._fetch_public_artist_meta", return_value=None), \
             mock.patch("hq_musica_profile._fetch_lyrics_sample", return_value=None):
            status, body = hq_musica.http_post("/api/musica/profile/fetch", {"async": False, "synthesize": False})
        self.assertEqual(status, 200)
        self.assertTrue(body["ok"])
        self.assertGreater(body["analysis"]["source_coverage"]["journal_plays"], 0)

        st_code, st_body = hq_musica.http_get("/api/musica/profile/status")
        self.assertEqual(st_code, 200)
        self.assertEqual(st_body["fetch_state"]["stage"], "done")

    def test_profile_edit_overrides_and_deep_signals(self):
        self._seed_local_data()
        # Edit custom notes, favorite artists, preferred genres, patterns, and bans via HTTP route
        code, res = hq_musica.http_post("/api/musica/profile/edit", {
            "favorite_artists": ["Gloryhammer", "HEALTH"],
            "preferred_genres": ["symphonic power metal", "brazilian phonk"],
            "musical_patterns": ["slowed reverb", "epic choir"],
            "banned_artists": ["Skip Forever"],
            "custom_notes": "Power metal for morning training, slowed phonk at night.",
        })
        self.assertEqual(code, 200)
        self.assertTrue(res["ok"])
        self.assertEqual(res["overrides"]["custom_notes"], "Power metal for morning training, slowed phonk at night.")
        self.assertIn("Gloryhammer", hq_music.get_profile()["favorite_artists"])
        self.assertIn("Skip Forever", hq_music.get_taste()["banned_artists"])

        prompt_text = hq_musica_profile.prompt_dossier()
        self.assertIn("Power metal for morning training", prompt_text)

        # Verify obsessed tracks & repeat ratio from journal
        dossier = res["analysis"]
        ac = dossier["acoustic_fingerprint"]
        self.assertIsNotNone(ac["artist_concentration_top5_pct"])
        self.assertIn("overrides", hq_musica.http_get("/api/musica/profile")[1])

    def test_advanced_six_dimensions_and_tick_drift(self):
        now = datetime.now(timezone.utc)
        # Bind a fake calendar with a sport event overlapping morning plays
        def fake_calendar(start, end):
            return [{
                "title": "Gym Workout",
                "category": "sport",
                "start": (now - timedelta(hours=2)).isoformat(),
                "end": (now + timedelta(hours=1)).isoformat(),
                "all_day": False,
            }]
        hq_music.bind(root=self.temp.name, calendar=fake_calendar)

        # Seed plays in same session: Gloryhammer -> Sabaton -> Mechagnome
        hq_music_journal.record([
            {"uri": "spotify:track:s1", "name": "Battle King", "artists": ["Gloryhammer"], "duration_ms": 240000,
             "played_at": (now - timedelta(minutes=30)).isoformat().replace("+00:00", "Z")},
            {"uri": "spotify:track:s2", "name": "Steel Victory", "artists": ["Sabaton"], "duration_ms": 240000,
             "played_at": (now - timedelta(minutes=25)).isoformat().replace("+00:00", "Z")},
            {"uri": "spotify:track:s3", "name": "Drift Phonk", "artists": ["Mechagnome"], "duration_ms": 120000,
             "played_at": (now - timedelta(minutes=20)).isoformat().replace("+00:00", "Z")},
        ])

        # Seed discoveries & DJ fatigue signals
        hq_music.add_discoveries([
            {"title": "Track A", "artist": "New Band", "source_url": "https://open.spotify.com/track/1", "confidence": 0.8},
        ])
        hq_music.set_discovery_status(hq_music.get_discoveries()[0]["id"], "liked")
        hq_music._write("dj_state.json", {
            "artist_signal": {
                "gloryhammer": {"name": "Gloryhammer", "done": 6, "skipped": 2},
                "spam band": {"name": "Spam Band", "done": 0, "skipped": 4},
            },
            "pool_stats": {
                "classics": {"done": 8, "skipped": 1},
                "discovery": {"done": 2, "skipped": 5},
            },
        })
        # Seed prior month snapshot for drift comparison
        prev_month = (now.replace(day=1) - timedelta(days=2)).strftime("%Y-%m")
        hq_music._write("musica_profile_history.json", {
            "version": 1,
            "snapshots": [{
                "month": prev_month,
                "captured_utc": "2026-10-01T00:00:00Z",
                "macro_families": {"Metal & Heavy": 40.0, "Phonk & Drift": 10.0},
                "top_artists": ["Gloryhammer", "Old Artist"],
            }],
        })
        # Seed artist genres in raw cache + test LRCLIB sampling
        hq_music._write("musica_profile_raw.json", {
            "version": 1,
            "checked": 9e12,
            "fetched_utc": "2026-11-15T00:00:00Z",
            "spotify_connected": True,
            "spotify": {
                "top_artists": {"short": [
                    {"id": "g1", "name": "Gloryhammer", "genres": ["power metal"], "popularity": 60},
                    {"id": "m1", "name": "Mechagnome", "genres": ["brazilian phonk"], "popularity": 40},
                ]},
                "top_tracks": {"short": [
                    {"id": "s1", "uri": "spotify:track:s1", "name": "Battle King", "artists": ["Gloryhammer"], "duration_ms": 240000},
                ]},
                "saved_tracks": [],
                "saved_albums": [],
                "playlists": [],
                "recent": [],
                "artist_cache": {},
            },
        })

        with mock.patch("hq_musica.lookup_synced_lyrics", return_value={
            "ok": True,
            "lrc": "[00:01.00] the battle king and sword of glory in the war",
        }):
            hq_musica_profile._fetch_lyrics_sample([
                {"name": "Battle King", "artists": ["Gloryhammer"], "duration_ms": 240000}
            ])

        dossier = hq_musica_profile.analyze_profile(now=now)

        # 1. Session flow
        flow = dossier["session_flow"]
        self.assertGreaterEqual(flow["session_count"], 1)
        self.assertTrue(any(t["from"] == "Gloryhammer" and t["to"] == "Sabaton" for t in flow["artist_transitions"]))

        # 2. Lyrical profile
        lyr = dossier["lyrical_profile"]
        self.assertEqual(lyr["lyrics_cached_tracks"], 1)
        self.assertTrue(any(th["theme"] == "epic_battle_fantasy" for th in lyr["top_themes"]))

        # 3. Fatigue vs true dislike
        fat = dossier["fatigue_profile"]
        self.assertTrue(any(x["name"] == "Spam Band" for x in fat["true_dislikes"]))

        # 4. Calendar correlation
        cal = dossier["calendar_correlation"]
        self.assertTrue(cal["available"])
        self.assertGreaterEqual(cal["matched_plays"], 3)
        self.assertIn("sport", cal["activities"])

        # 5. Novelty profile
        nov = dossier["novelty_profile"]
        self.assertEqual(nov["discovery_accepted"], 1)
        self.assertIn(nov["sweet_spot_label"], {"comfort_heavy", "balanced_explorer", "novelty_hunter"})

        # 6. Drift profile & tick()
        drf = dossier["drift_profile"]
        self.assertEqual(drf["compared_to_month"], prev_month)
        self.assertTrue(len(drf["macro_family_deltas"]) >= 1)
        hq_musica_profile.tick(now=now)  # should not raise

        # Tool queries for new sections
        for sec in ("flow", "lyrics", "fatigue", "calendar", "novelty", "drift",
                    "axes", "tracks", "albums", "collabs", "tournaments", "paradoxes", "recipes", "hourly"):
            res = hq_musica._run_tool("my_taste_profile", {"section": sec})
            self.assertTrue(res["ok"])

    def test_exhaustive_14_layer_fusion_overrides_and_public_enrichment(self):
        self._seed_local_data()
        now = datetime.now(timezone.utc)
        # Seed dig cache, radar, feedback history, SMTC play history, tournament hall, and collaborations
        hq_music._write("dj-dig-cache.json", {
            "liked": {"at": 1000, "rows": [
                {"uri": "spotify:track:d1", "name": "MONTAGEM TEST", "artists": ["ZXKAI", "DJ Asul"],
                 "album": "Phonkwave Vol 1", "duration_ms": 115000, "why": "dans tes titres aimés", "pool": "liked"},
            ]},
            "deep_cuts": {"at": 1000, "rows": [
                {"uri": "spotify:track:d2", "name": "Steel Vault", "artists": ["Victorius"],
                 "album": "Space Ninjas", "duration_ms": 305000, "why": "de ta playlist « Training Metal »", "pool": "deep_cuts"},
            ]},
        })
        hq_music._write("radar.json", {"items": [
            {"id": "r1", "name": "New Metal Drop", "artists": ["Gloryhammer"], "year": "2026"},
        ]})
        hq_music._write("musica_play_history.json", {"items": [
            {"artist": "Sabaton", "title": "Night Witches", "album": "Heroes", "play_count": 7},
        ]})
        hq_music._write("tournament-hall.json", {
            "played": 3,
            "songs": {
                "s1": {"name": "Battle Hymn 0", "artist": "Gloryhammer", "uri": "spotify:track:pm0",
                       "wins": 4, "losses": 0, "titles": 1, "finals": 1},
            },
            "artists": {"gloryhammer": {"name": "Gloryhammer", "finals": 1, "titles": 1}},
            "champions": [{"at": "2026-11-15T12:00", "angle": "metal", "name": "Battle Hymn 0", "artist": "Gloryhammer", "uri": "spotify:track:pm0"}],
            "rivalry": {"master": 2, "musica": 1},
        })
        hq_music.record_feedback(
            "Andromeda", "Skip Track", False, action="dismiss",
            uri="spotify:track:1111111111111111111111",
        )

        # Offline Spotify + public MusicBrainz fallback enrichment
        def fake_public(name):
            if name.casefold() == "zxkai":
                return {"name": "ZXKAI", "genres": ["brazilian phonk", "montagem"], "country": "BR", "artist_type": "Person"}
            if name.casefold() == "gloryhammer":
                return {"name": "Gloryhammer", "genres": ["symphonic power metal", "power metal"], "country": "GB", "artist_type": "Group"}
            if name.casefold() == "sabaton":
                return {"name": "Sabaton", "genres": ["power metal", "heavy metal"], "country": "SE", "artist_type": "Group"}
            return None

        with mock.patch("hq_spotify.status", return_value={"connected": False}), \
             mock.patch("hq_musica_profile._fetch_public_artist_meta", side_effect=fake_public), \
             mock.patch("hq_musica_profile._fetch_lyrics_sample", return_value=None):
            res_fetch = hq_musica_profile.run_full_pipeline(deep=True, force=True, synthesize=False, sync_preferences=True)

        self.assertTrue(res_fetch["ok"])
        dossier = res_fetch["analysis"]
        cov = dossier["source_coverage"]
        self.assertGreaterEqual(cov["dj_dig_cache_tracks"], 2)
        self.assertGreaterEqual(cov["radar_releases_tracked"], 1)
        self.assertGreaterEqual(cov["tournament_matches_played"], 4)
        self.assertGreaterEqual(cov["artist_genres_cached"], 3)

        # Verify all 14 layers populated cleanly
        self.assertEqual(len(dossier["sonic_axes"]), 6)
        self.assertEqual(len(dossier["circadian_profile"]["hourly_curve"]), 24)
        self.assertEqual(len(dossier["circadian_profile"]["weekday_curve"]), 7)
        self.assertGreaterEqual(len(dossier["track_signatures"]["top_tracks"]), 3)
        self.assertTrue(any(cp["artists"] == ["DJ Asul", "ZXKAI"] for cp in dossier["collaboration_network"]["top_collaborations"]))
        self.assertEqual(dossier["tournament_intelligence"]["tournaments_played"], 3)
        self.assertEqual(dossier["tournament_intelligence"]["rivalry"]["master_wins"], 2)
        self.assertTrue(any(r["artist"] == "Andromeda" for r in dossier["fatigue_profile"]["track_feedback_rejects"]))
        self.assertGreaterEqual(dossier["drift_profile"]["weekly_momentum"]["plays_last_7d"], 1)
        self.assertTrue(len(dossier["taste_paradoxes"]) >= 1)
        self.assertIn("daypart_soundtracks", dossier["actionable_recipes"])

        # Extended overrides preservation & scoring impact
        code, ed = hq_musica.http_post("/api/musica/profile/edit", {
            "favorite_artists": ["Manual Anchor"],
            "boosted_artists": ["Boosted Hero"],
            "boosted_genres": ["darksynth"],
            "pinned_tracks": ["Gloryhammer — Keeper of the Celestial Flame"],
            "mood_rules_override": {"nuit": "Slowed phonk & darksynth", "sport": "160+ BPM metal"},
            "target_bpm_range": {"min": 120, "max": 180},
            "novelty_target": 0.45,
            "language_preferences": ["en", "pt"],
            "context_tags": ["gym", "coding"],
            "custom_notes": "Keep transitions relentless.",
        })
        self.assertEqual(code, 200)
        ov = ed["overrides"]
        self.assertEqual(ov["boosted_artists"], ["Boosted Hero"])
        self.assertEqual(ov["target_bpm_range"], {"min": 120, "max": 180})
        self.assertEqual(ov["novelty_target"], 0.45)

        ed_dossier = ed["analysis"]
        ed_names = [a["name"] for a in ed_dossier["artist_affinities"]]
        self.assertIn("Boosted Hero", ed_names)
        self.assertIn("Manual Anchor", ed_names)
        self.assertIn("darksynth", [g["genre"] for g in ed_dossier["genre_profile"]["top_genres"]])

        # sync_music_preferences must NOT clobber Manual Anchor or Boosted Hero
        synced = hq_musica_profile.sync_music_preferences(ed_dossier)
        self.assertIn("Manual Anchor", synced["favorite_artists"])
        self.assertIn("Boosted Hero", synced["favorite_artists"])
        self.assertIn("darksynth", synced["preferred_genres"])

        # Prompt reflects overrides & signature content
        prompt = hq_musica_profile.prompt_dossier()
        self.assertIn("Boosted Hero", prompt)
        self.assertIn("120-180", prompt)


if __name__ == "__main__":
    unittest.main()
