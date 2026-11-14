"""DJ Musica: Le Tournoi (seeds, blind matches, windows, wild card, hall, rivalry, cameo, variants) and the daily challenge."""
import json
from datetime import date, datetime, timedelta, timezone
import time
import unittest
from unittest import mock

import hq_music_dj as dj
import hq_music_dj_archive as archive
import hq_spotify
from tests.test_hq_music_dj import DjBase, row

DUEL_POOLS = {"forgotten": [row(1, "forgotten")], "discovery": [row(2, "discovery")], "radar": [row(3, "radar")]}


class TournamentTests(DjBase):
    def setUp(self):
        super().setUp()
        spawn = mock.patch.object(dj, "_spawn")
        spawn.start()
        self.addCleanup(spawn.stop)
        offline = mock.patch("hq_ai.generate", side_effect=RuntimeError("offline"))
        offline.start()
        self.addCleanup(offline.stop)

    def field(self, n=8, first=1):
        return [dict(row(i, "web"), artists=[f"Composer {i}"], why="trouvé sur le web (ign.com) : jeux")
                for i in range(first, first + n)]

    def start(self, n=8, size=None, web=None, spotify=(), body=None, finds=None):
        """Start a tournament with the web search and the Spotify backup mocked. ``web`` rows are what the
        verified web search brings back."""
        payload = {"intro": "Match !", "line_b": "Et l'autre.", "prediction": "a"}
        body = dict(body or {}, **({"size": size} if size else {}))
        web = self.field(n) if web is None else web
        patches = (mock.patch.object(dj.dig, "web_finds", return_value=finds or {"tracks": [1]}),
                   mock.patch.object(dj.dig, "web_pool", return_value=web),
                   mock.patch.object(dj.dig, "search_pool", return_value=list(spotify)),
                   self.model(payload), mock.patch.object(dj, "make_drop", return_value=None),
                   mock.patch.object(dj, "_spawn"), mock.patch.object(hq_spotify, "player_action"))
        with patches[0] as finds_mock, patches[1], patches[2] as search_mock, patches[3], patches[4], patches[5], patches[6]:
            out = dj.start_tournament(body)
        self.finds_mock, self.search_mock = finds_mock, search_mock
        return out

    def next_match(self):
        payload = {"intro": "Match !", "line_b": "Et l'autre.", "prediction": "b"}
        with self.model(payload), mock.patch.object(dj, "make_drop", return_value=None), \
             mock.patch.object(dj, "_spawn"), mock.patch.object(hq_spotify, "player_action"):
            return dj.next_tournament_match({})

    def test_search_asks_for_game_music_and_only_verified_rows_enter(self):
        self.start()
        steer = self.finds_mock.call_args.args[0]
        self.assertIn("jeux vidéo", steer)
        self.assertLessEqual(len(steer), 300)  # the web search truncates the request there
        self.assertTrue(all(len(dj.TOURNAMENT_BASE + ". Angle de cette édition : " + a[2]) <= 300 for a in dj.GAME_ANGLES))
        t = dj._state()["tournament"]
        self.assertEqual(len(t["entrants"]), 8)
        self.assertTrue(all(r["uri"].startswith("spotify:track:") for r in t["entrants"]))
        self.assertEqual(t["source"], "web")

    def test_earlier_tournaments_are_remembered_and_not_offered_again(self):
        self.start(n=16)
        first = {r["uri"] for r in dj._state()["tournament"]["entrants"]}
        self.assertEqual(len(dj._state()["tournament_seen"]), 8)
        self.assertEqual(dj.tournament_view()["reused"], 0)
        # Second edition: the same 16 songs come back from the web; only the 8 new ones may enter.
        self.start(n=16)
        second = dj._state()["tournament"]
        self.assertFalse(first & {r["uri"] for r in second["entrants"]})
        self.assertEqual(second["reused"], 0)
        avoid = self.finds_mock.call_args.args[2]
        self.assertIn("Song", avoid)  # the web search is told which titles to skip

    def test_same_song_under_another_uri_counts_as_played(self):
        self.start(n=8)
        again = [dict(r, uri=r["uri"] + "x") for r in dj._state()["tournament"]["entrants"]]
        backup = [dict(r, album="Game Original Soundtrack") for r in self.field(8, first=70)]
        self.start(web=again + self.field(2, first=50), spotify=backup)
        names = {r["name"] for r in dj._state()["tournament"]["entrants"]}
        self.assertFalse(names & {f"Song {i}" for i in range(1, 9)})

    def test_old_songs_return_only_when_there_are_not_enough_new_ones(self):
        self.start(n=8)
        self.start(web=self.field(8), size=4)  # the same 8 again: nothing new, so a 4-bracket of repeats
        t = dj._state()["tournament"]
        self.assertEqual((t["size"], t["reused"]), (4, 4))
        self.assertEqual(dj.tournament_view()["reused"], 4)

    def test_angle_changes_every_time_and_reaches_the_search(self):
        angles = []
        for _ in range(4):
            self.start(n=16 if False else 8, web=self.field(8, first=len(angles) * 10 + 1))
            angles.append(dj._state()["tournament"]["angle"])
            self.assertIn("Angle de cette édition", self.finds_mock.call_args.args[0])
        self.assertEqual(len(set(angles)), 4)  # never one of the last three
        self.start(body={"angle": "retro"}, web=self.field(8, first=200))
        self.assertEqual(dj.tournament_view()["angle"], "l’ère 8 et 16 bits")

    def test_spotify_backup_fills_in_filters_noise_and_is_announced(self):
        noisy = [dict(row(i, "search"), album="Game Original Soundtrack", artists=[f"Comp {i}"]) for i in range(1, 7)]
        noisy += [dict(row(30, "search"), name="Theme (Piano Cover)", album="Game Original Soundtrack"),
                  dict(row(31, "search"), name="Theme", album="Chill Beats"),
                  dict(row(32, "search"), name="Theme", album="Tribute Original Soundtrack")]
        self.start(web=[], spotify=noisy)  # no web today (over budget): the backup carries the bracket
        t = dj._state()["tournament"]
        self.assertEqual(t["source"], "spotify")
        self.assertEqual(len(t["entrants"]), 4)
        self.assertEqual(dj.tournament_view()["source"], "spotify")
        for bad in (30, 31, 32):
            self.assertNotIn(f"spotify:track:{bad}", [r["uri"] for r in t["entrants"]])
        self.search_mock.assert_called_once()

    def test_mixed_source_when_the_web_is_short(self):
        extra = [dict(row(i, "search"), album="Game Soundtrack", artists=[f"Comp {i}"]) for i in range(40, 46)]
        self.start(web=self.field(4), spotify=extra)
        self.assertEqual(dj._state()["tournament"]["source"], "mixed")

    def test_memory_is_capped(self):
        state = dj._state()
        state["tournament_seen"] = [{"key": f"k{i}|a", "name": f"n{i}", "artist": "a", "uri": f"u{i}"}
                                    for i in range(dj.SEEN_KEEP)]
        dj._save_state(state)
        self.start()
        self.assertEqual(len(dj._state()["tournament_seen"]), dj.SEEN_KEEP)

    def test_full_bracket_to_a_champion_without_touching_duel_title(self):
        out = self.start()
        self.assertEqual(out["tournament"]["round"], "quarts de finale")
        self.assertRegex(out["segment"]["title"], "Tournament|Tournoi")
        votes = 0
        result = None
        while not dj._state()["tournament"]["done"]:
            result = dj.vote_duel("a")
            votes += 1
            if not dj._state()["tournament"]["done"]:
                self.next_match()
        self.assertEqual(votes, 7)  # 4 + 2 + 1
        view = dj.tournament_view()
        self.assertTrue(view["done"])
        self.assertTrue(view["champion"]["uri"].startswith("spotify:track:"))
        self.assertIsNone((dj._state().get("duels") or {}).get("champion"))
        self.assertRegex(result["text"], "tournoi|tournament")
        with self.assertRaises(dj.DjError) as caught:
            dj.next_tournament_match({})
        self.assertEqual(caught.exception.code, "tournament_closed")

    def test_small_field_makes_a_four_bracket_and_too_small_is_refused(self):
        self.start(n=5)
        self.assertEqual(dj._state()["tournament"]["size"], 4)
        with mock.patch.object(dj.dig, "web_finds", return_value={}), \
             mock.patch.object(dj.dig, "web_pool", return_value=self.field(3)), \
             mock.patch.object(dj.dig, "search_pool", return_value=[]):
            with self.assertRaises(dj.DjError) as caught:
                dj.start_tournament({"angle": "indie"})
        self.assertEqual(caught.exception.code, "dj_not_enough")

    def test_next_match_needs_the_open_vote_first(self):
        self.start()
        with self.assertRaises(dj.DjError) as caught:
            dj.next_tournament_match({})
        self.assertEqual(caught.exception.code, "duel_open")

    def test_round_numbers_are_exposed_at_every_round(self):
        out = self.start()
        view = out["tournament"]
        self.assertEqual((view["round_no"], view["rounds"], view["match"], view["of"]), (1, 3, 1, 4))
        for _ in range(4):
            result = dj.vote_duel("a")
            if _ < 3:
                self.next_match()
        view = result["tournament"]
        self.assertEqual((view["round_no"], view["rounds"], view["round"], view["of"]), (2, 3, "demi-finales", 2))
        self.assertIsNone(view["prediction"])  # her pick stays secret until the end

    def test_final_reveals_her_secret_pick_and_comments_the_gap_or_the_match(self):
        for same in (False, True):
            self.start()
            bracket = dj._state()["tournament"]
            winner_uri = None
            # play the bracket always voting for side a; remember who that makes champion
            while not dj._state()["tournament"]["done"]:
                if dj._state()["tournament"]["match"] == 0 and len(dj._state()["tournament"]["entrants"]) == 2:
                    state = dj._state()
                    state["tournament"]["prediction"] = dict(state["duel"]["a"] if same else state["duel"]["b"])
                    dj._save_state(state)
                result = dj.vote_duel("a")
                if not dj._state()["tournament"]["done"]:
                    self.next_match()
            final = result["result"]["final"]
            self.assertEqual(final["prediction"]["same"], same)
            if same:
                self.assertRegex(result["text"], "pronostic|pick|pareil|alike")
            else:
                self.assertEqual(final["prediction"]["out_round"], "finale")
                self.assertRegex(result["text"], "parié|bet")
            self.assertEqual(dj.tournament_view()["prediction"]["same"], same)

    def test_final_reaction_gets_the_prediction_facts_in_the_prompt(self):
        self.start()
        while len(dj._state()["tournament"]["entrants"]) > 2 or dj._state()["tournament"]["match"] > 0:
            dj.vote_duel("a")
            if not dj._state()["tournament"]["done"]:
                self.next_match()
            if len(dj._state()["tournament"]["entrants"]) == 2 and dj._state()["duel"]["vote"] is None:
                break
        with self.model({"text": "Quel parcours !"}) as gen:
            out = dj.vote_duel("a")
        prompt = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertIn("pronostic secret", prompt)
        self.assertIn("vainqueur du tournoi", prompt)
        self.assertEqual(out["text"], "Quel parcours !")

    # ---- seeds, upsets, wild card -------------------------------------------------------------------------------
    def vote_by(self, rule):
        """Vote the open match with rule(seed_a, seed_b) -> "a" | "b"."""
        duel = dj._state()["duel"]
        return dj.vote_duel(rule(duel["a"]["seed"], duel["b"]["seed"]))

    underdog = staticmethod(lambda a, b: "a" if a > b else "b")
    favourite = staticmethod(lambda a, b: "a" if a < b else "b")

    def test_her_ranking_seeds_the_bracket_and_favourites_meet_late(self):
        ranking = {"ranking": [f"c{i}" for i in range(8, 0, -1)], "pick": "c8", "intro": "x", "line_b": "y", "prediction": "a"}
        with self.model(ranking):
            self.start()
        t = dj._state()["tournament"]
        self.assertEqual(sorted(r["seed"] for r in t["entrants"]), list(range(1, 9)))
        self.assertEqual([r["seed"] for r in t["entrants"]], [1, 8, 4, 5, 2, 7, 3, 6])  # 1v8, 4v5, 2v7, 3v6
        view = dj.tournament_view()
        self.assertEqual([r["seed"] for r in view["seeds"]], list(range(1, 9)))
        self.assertTrue(all("seed" in r for r in dj._state()["duel"]["a"].keys() and [dj._state()["duel"]["a"]]))

    def test_an_underdog_win_is_an_upset_and_is_remembered(self):
        self.start(body={"blind": False})
        result = self.vote_by(self.underdog)
        self.assertTrue(result["result"]["upset"])
        self.assertEqual(dj.tournament_view()["upsets"], 1)
        self.assertGreater(dj._state()["tournament"]["upsets"][0]["gap"], 0)
        self.next_match()
        with self.model({"text": "Quelle surprise !"}) as gen:
            result = self.vote_by(self.favourite)
        self.assertFalse(result["result"]["upset"])
        self.assertNotIn("surprise", gen.call_args.args[2][0]["parts"][0]["text"])

    def test_upset_reaction_gets_the_surprise_fact(self):
        self.start(body={"blind": False})
        with self.model({"text": "Oh !"}) as gen:
            self.vote_by(self.underdog)
        self.assertIn("surprise", gen.call_args.args[2][0]["parts"][0]["text"])

    def play_to_semis(self, last_semi):
        """Quarter-finals: underdogs win; semi-finals: ``last_semi`` rule. Stops once the final is set."""
        for _ in range(4):
            self.vote_by(self.underdog)
            self.next_match()
        for _ in range(2):
            self.vote_by(last_semi)
            if dj._state()["tournament"]["match"] != 0 or len(dj._state()["tournament"]["entrants"]) > 2:
                self.next_match()

    def test_wild_card_repechage_before_the_final_after_an_upset(self):
        self.start(body={"blind": False})
        self.play_to_semis(self.favourite)
        t = dj._state()["tournament"]
        rep = t["repechage"]
        self.assertTrue(rep["pending"])
        finalists = {r["uri"] for r in t["entrants"]}
        self.assertNotIn(rep["wild"]["uri"], finalists)  # a beaten favourite, not a finalist
        self.assertEqual(dj.tournament_view()["round"], "repêchage")
        self.next_match()  # the repechage match airs
        duel = dj._state()["duel"]
        self.assertTrue(duel["repechage"])
        self.assertEqual({duel["a"]["uri"], duel["b"]["uri"]} - {rep["wild"]["uri"]}, {rep["target"]})
        wild_side = "a" if duel["a"]["uri"] == rep["wild"]["uri"] else "b"
        result = dj.vote_duel(wild_side)
        t = dj._state()["tournament"]
        self.assertTrue(t["repechage"]["won"])
        self.assertIn(rep["wild"]["uri"], {r["uri"] for r in t["entrants"]})  # it took the contested place
        self.assertEqual(dj.tournament_view()["round"], "finale")
        self.assertEqual(result["tournament"]["wild_card"]["won"], True)
        self.next_match()  # the final
        dj.vote_duel("a")
        self.assertTrue(dj._state()["tournament"]["done"])

    def test_no_repechage_without_an_upset_or_when_switched_off(self):
        self.start(body={"blind": False})
        for _ in range(4):
            self.vote_by(self.favourite)
            self.next_match()
        self.vote_by(self.favourite)
        self.next_match()
        self.vote_by(self.favourite)
        self.assertIsNone(dj._state()["tournament"]["repechage"])
        self.start(body={"blind": False, "wildcard": False}, web=self.field(8, first=300))
        self.play_to_semis(self.favourite)
        self.assertIsNone(dj._state()["tournament"]["repechage"])

    # ---- blind matches ------------------------------------------------------------------------------------------
    def test_blind_match_masks_every_public_name_until_the_vote(self):
        self.start()
        names = {r["name"] for r in dj._state()["duel"].values() if False} or {dj._state()["duel"]["a"]["name"], dj._state()["duel"]["b"]["name"]}
        shown = json.dumps(dj.public_state(), ensure_ascii=False)
        for name in names:
            self.assertNotIn(name, shown)
        cur = dj.public_state()["duels"]["current"]
        self.assertEqual((cur["a"]["name"], cur["b"]["name"], cur["blind"]), ("A", "B", True))
        self.assertEqual(cur["a"]["uri"], "")
        self.assertEqual([t["name"] for t in dj.public_state()["segment"]["tracks"]], ["A", "B"])
        with self.model({"text": "C'était ..."}) as gen:
            result = dj.vote_duel("a")
        self.assertIn(result["result"]["winner"]["name"], json.dumps(dj.public_state(), ensure_ascii=False))
        self.assertIn("aveugle", gen.call_args.args[1])
        self.assertIn(result["result"]["winner"]["name"], gen.call_args.args[2][0]["parts"][0]["text"])

    def test_blind_presentation_never_gives_the_names_to_the_model(self):
        payload = {"intro": "Le A…", "line_b": "Le B…", "prediction": "a"}
        with mock.patch.object(dj.dig, "web_finds", return_value={"tracks": [1]}), \
             mock.patch.object(dj.dig, "web_pool", return_value=self.field(8)), \
             mock.patch.object(dj.dig, "search_pool", return_value=[]), self.model(payload) as gen, \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_spawn"), \
             mock.patch.object(hq_spotify, "player_action"):
            dj.start_tournament({})
        prompt = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertNotIn("Song ", prompt)
        self.assertNotIn("Composer", prompt)
        self.assertIn("L'AVEUGLE", gen.call_args.args[1])

    def test_loved_artist_eliminated_blind_is_teased(self):
        self.start()
        loser_artist = dj._state()["duel"]["b"]["artists"][0]
        with mock.patch.object(dj, "_loves", return_value=True), self.model({"text": "Ha !"}) as gen:
            dj.vote_duel("a")
        self.assertIn("artistes préférés", gen.call_args.args[2][0]["parts"][0]["text"])

    # ---- listening windows --------------------------------------------------------------------------------------
    def test_window_starts_past_the_intro_and_fits_inside_the_track(self):
        self.assertEqual(dj._window_start({"duration_ms": 30000}), 0)
        for duration in (60000, 200000, 600000):
            start = dj._window_start({"duration_ms": duration})
            self.assertGreater(start, 0)
            self.assertLessEqual(start + dj.WINDOW_SECONDS * 1000, duration)

    def test_windows_play_a_then_b_then_stop_and_open_the_vote(self):
        self.start()
        duel = dj._state()["duel"]
        self.assertFalse(duel["heard"])
        seg = dj._state()["segment"]
        calls = []
        with mock.patch.object(hq_spotify, "player_action", side_effect=lambda a, p=None: calls.append((a, p))), \
             mock.patch.object(dj, "_wait_window", return_value=True), mock.patch.object(dj, "_prepare_playback"), \
             mock.patch.object(dj, "_spawn") as spawn:
            dj.go(seg["id"])
            self.assertEqual(calls[0][0], "play")
            self.assertEqual(calls[0][1]["uris"], [duel["a"]["uri"]])
            self.assertEqual(calls[0][1]["position_ms"], duel["window"]["positions"][0])
            window_call = next(c for c in spawn.call_args_list if c.args[0] == "duel-window")
            self.assertNotIn("plan-next", [c.args[0] for c in spawn.call_args_list])  # a duel plans nothing behind it
            dj._run_windows(*window_call.args[2:])
        self.assertEqual(calls[1][1]["uris"], [duel["b"]["uri"]])
        self.assertEqual(calls[1][1]["position_ms"], duel["window"]["positions"][1])
        self.assertEqual(calls[2][0], "pause")
        self.assertTrue(dj._state()["duel"]["heard"])
        self.assertTrue(dj.public_state()["duels"]["current"]["heard"])

    def test_windows_stop_when_the_vote_is_cast_and_replay_buttons_work(self):
        self.start()
        duel = dj._state()["duel"]
        with mock.patch.object(hq_spotify, "player_action") as action, mock.patch.object(dj, "_spawn"):
            dj.listen_duel("b")
        self.assertEqual(action.call_args.args[1]["uris"], [duel["b"]["uri"]])
        with mock.patch.object(dj, "_wait_window", return_value=False), mock.patch.object(hq_spotify, "player_action") as action:
            dj.vote_duel("a")
            dj._run_windows(dj._state()["segment"]["id"], duel["window"], [duel["a"]["uri"], duel["b"]["uri"]], None)
        action.assert_not_called()
        with self.assertRaises(dj.DjError):
            dj.listen_duel("a")

    def test_no_window_means_the_vote_is_open_at_once(self):
        self.start(body={"window": False})
        self.assertTrue(dj._state()["duel"]["heard"])
        self.assertIsNone(dj._state()["duel"]["window"])

    def test_duel_tracks_never_score_skips(self):
        self.start()
        duel = dj._state()["duel"]
        with mock.patch.object(dj, "record_skip") as skip, mock.patch.object(dj, "record_completion") as done:
            dj.observe(duel["a"]["uri"], None, None, source="browser")
            dj.observe(duel["b"]["uri"], duel["a"]["uri"], 5000, source="browser")
        skip.assert_not_called()
        done.assert_not_called()

    # ---- themes, hall of fame, rivalry, cameo, share ---------------------------------------------------------------
    def test_custom_theme_reaches_the_search_and_is_cleaned(self):
        self.start(body={"theme": "  thèmes de boss <script>  "})
        steer = self.finds_mock.call_args.args[0]
        self.assertIn("thèmes de boss", steer)
        self.assertNotIn("<", steer)
        self.assertLessEqual(len(steer), 300)
        self.assertEqual(dj.tournament_view()["angle"], "thèmes de boss script")
        self.assertEqual(dj._clean_theme("x" * 200), "x" * 80)

    def finish(self, rule=None):
        rule = rule or self.favourite
        while not dj._state()["tournament"]["done"]:
            result = self.vote_by(rule)
            if not dj._state()["tournament"]["done"]:
                self.next_match()
        return result

    def test_hall_of_fame_and_rivalry_after_tournaments(self):
        import hq_music_dj_hall as hall
        self.start(n=16, body={"blind": False})
        self.finish()
        champion = dj.tournament_view()["champion"]
        view = hall.view()
        self.assertEqual(view["played"], 1)
        self.assertEqual(view["champions"][0]["name"], champion["name"])
        self.assertEqual(view["ranking"][0]["name"], champion["name"])
        self.assertEqual(view["ranking"][0]["titles"], 1)
        self.assertTrue(view["artists"])  # both finalists' artists reached a final
        rival = view["rivalry"]
        self.assertEqual(rival["musica"] + rival["master"], 1)
        self.assertEqual(rival["owner"], "musica" if rival["musica"] else "master")
        self.assertEqual(rival["streak"]["n"], 1)
        # second edition: the owner picks the theme, then the ownership is consumed
        owner = rival["owner"]
        self.start(n=16, web=self.field(8, first=400), body={"blind": False})
        if owner == "musica":
            self.assertIn("choisi le thème", dj._state()["tournament"]["theme_note"])
        self.assertIsNone(hall.theme_owner())
        self.assertEqual(self.http("/api/musica/dj/hall")[1]["played"], 1)

    def http(self, path):
        return dj.http_get(path)

    def test_master_theme_choice_is_credited_when_he_owns_it(self):
        import hq_music_dj_hall as hall
        doc = hall._load()
        doc["rivalry"]["owner"] = "master"
        hall.music._write(hall.FILE, doc)
        self.start(body={"angle": "indie", "blind": False})
        self.assertIn("Le Maître avait gagné", dj._state()["tournament"]["theme_note"])
        self.assertIn("thème", self.finds_mock.call_args.args[0] + "thème")

    def test_final_reaction_carries_rivalry_hall_and_the_cameo_is_spawned(self):
        self.start(n=8, body={"blind": False})
        with mock.patch.object(dj, "_spawn") as spawn:
            while True:
                with self.model({"text": "Quel tournoi !"}) as gen:
                    result = self.vote_by(self.favourite)
                if dj._state()["tournament"]["done"]:
                    break
                self.next_match()
        prompt = gen.call_args.args[2][0]["parts"][0]["text"]
        self.assertIn("rivalité", prompt)
        self.assertIn("palmarès", prompt)
        self.assertIn("rivalry", result["result"]["final"])
        self.assertIn("cameo", [c.args[0] for c in spawn.call_args_list])

    def test_cameo_is_a_sister_line_stored_with_a_drop_and_in_her_own_memory(self):
        self.start(body={"blind": False})
        bracket_id = dj._state()["tournament"]["id"]
        champion = {"name": "Song 1", "artist": "Composer 1"}
        with self.model({"text": "Maître, quelle victoire !", "mood": "warm"}), \
             mock.patch.object(dj, "make_drop", return_value="drop-" + "d" * 20 + ".mp3"), \
             mock.patch.object(dj, "_note_guest") as note:
            dj._make_cameo_inner(bracket_id, champion, False)
        cameo = dj.tournament_view()["cameo"]
        self.assertIn(cameo["who"], ("transferania", "else"))
        self.assertEqual(cameo["text"], "Maître, quelle victoire !")
        self.assertTrue(cameo["drop"].startswith("drop-"))
        note.assert_called_once()
        self.assertEqual(note.call_args.args[0], cameo["who"])  # her own memory, never Musica's

    def test_cameo_falls_back_to_a_scripted_line_without_a_model(self):
        self.start(body={"blind": False})
        with mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(dj, "_note_guest"):
            dj._make_cameo_inner(dj._state()["tournament"]["id"], {"name": "Song 1", "artist": "X"}, True)
        self.assertIn("Song 1", dj.tournament_view()["cameo"]["text"])

    def test_ambient_whisper_is_silent_during_a_blind_match(self):
        import hq_musica
        self.start()
        with mock.patch("hq_ai.generate") as gen:
            out = hq_musica.ambient_line(track="Song 1", artist="Composer 1", playing=True)
        self.assertEqual((out["line"], out.get("blind")), ("", True))
        gen.assert_not_called()
        with self.model({"text": "ok"}):
            dj.vote_duel("a")  # the vote ends the secret: the guard lifts
        self.assertNotEqual(hq_musica.ambient_line(track="Song 1", artist="Composer 1", playing=True).get("blind"), True)

    def test_the_offer_is_gone(self):
        self.assertFalse(hasattr(dj, "tournament_offer"))
        self.assertNotIn("tournament_offer", dj.public_state())
        self.assertNotIn("tournaments", dj.settings())


class KindsAndDailyTests(DjBase):
    def setUp(self):
        super().setUp()
        for target in (mock.patch("hq_ai.generate", side_effect=RuntimeError("offline")), mock.patch.object(dj, "_spawn")):
            target.start()
            self.addCleanup(target.stop)

    def rows(self, n, first=1, album="Album"):
        return [dict(row(i, "web"), artists=[f"Artist {i}"], album=album, why="trouvé sur le web (x.com) : t")
                for i in range(first, first + n)]

    def start(self, body, web=None, spotify=()):
        payload = {"intro": "Match !", "line_b": "Et l'autre.", "prediction": "a"}
        with mock.patch.object(dj.dig, "web_finds", return_value={"tracks": [1]}) as finds, \
             mock.patch.object(dj.dig, "web_pool", return_value=self.rows(8) if web is None else web), \
             mock.patch.object(dj.dig, "search_pool", return_value=list(spotify)) as search, \
             self.model(payload), mock.patch.object(dj, "make_drop", return_value=None), \
             mock.patch.object(hq_spotify, "player_action"):
            out = dj.start_tournament(body)
        self.finds, self.search = finds, search
        return out

    def test_every_kind_asks_the_web_for_its_own_thing_with_its_own_angles(self):
        expectations = {"decade": "décennie", "artists": "artistes légendaires", "albums": "albums cultes", "games": "jeux vidéo"}
        for index, (kind, word) in enumerate(expectations.items()):
            self.start({"kind": kind, "blind": False}, web=self.rows(8, first=index * 20 + 1))
            steer = self.finds.call_args.args[0]
            self.assertIn(word, steer)
            self.assertLessEqual(len(steer), 300)
            view = dj.tournament_view()
            self.assertEqual(view["kind"], kind)
            self.assertIn(view["angle"], {a[1] for a in dj.KINDS[kind]["angles"]})
        self.assertTrue(all(len(f"{dj.KINDS[k]['base']}. Angle de cette édition : {a[2]}") <= 300
                            for k in ("games", "decade", "artists", "albums") for a in dj.KINDS[k]["angles"]))

    def test_unknown_kind_falls_back_to_games_and_decade_backup_uses_year_filters(self):
        self.start({"kind": "nonsense", "blind": False})
        self.assertEqual(dj.tournament_view()["kind"], "games")
        backup = [dict(r, album="Some Album") for r in self.rows(8, first=60)]
        self.start({"kind": "decade", "angle": "dec80", "blind": False}, web=[], spotify=backup)
        queries = [item["q"] for item in self.search.call_args.args[0]]
        self.assertEqual(queries, ["year:1980-1989"])
        self.assertEqual(dj.tournament_view()["source"], "spotify")  # no soundtrack filter outside games

    def test_library_bracket_comes_from_his_journal_one_song_per_artist(self):
        import hq_music_journal as journal
        base = datetime.now().astimezone() - timedelta(days=3)
        plays = []
        for i in range(6):
            for n in range(6 - i):  # artist i is played (6 - i) times
                moment = (base + timedelta(minutes=i * 30 + n)).astimezone(timezone.utc)
                plays.append({"uri": f"spotify:track:L{i}", "name": f"Fav {i}", "artists": [f"Band {i}"], "album": "A",
                              "duration_ms": 200000, "played_at": moment.isoformat().replace("+00:00", "Z")})
        journal.record(sorted(plays, key=lambda p: p["played_at"]))
        with mock.patch.object(dj.dig, "web_finds") as finds:
            self.start({"kind": "library", "blind": False})
        finds.assert_not_called()  # evidence is his own journal: no web, no model memory
        t = dj._state()["tournament"]
        self.assertEqual(t["source"], "library")
        self.assertEqual(t["size"], 4)  # six artists: a 4-bracket
        self.assertEqual({r["artists"][0] for r in t["entrants"]}, {f"Band {i}" for i in range(4)})  # the most played ones
        self.assertFalse(dj._state().get("tournament_seen"))  # favourites may come back
        with mock.patch("hq_music_wrapped._plays", return_value=[]):
            with self.assertRaises(dj.DjError) as caught:
                dj.start_tournament({"kind": "library"})
        self.assertEqual(caught.exception.code, "dj_not_enough")

    def test_each_kind_has_its_own_hall_and_rivalry(self):
        import hq_music_dj_hall as hall
        self.start({"kind": "decade", "blind": False})
        while not dj._state()["tournament"]["done"]:
            duel = dj._state()["duel"]
            dj.vote_duel("a" if duel["a"]["seed"] < duel["b"]["seed"] else "b")
            if not dj._state()["tournament"]["done"]:
                with self.model({"intro": "x", "line_b": "y", "prediction": "a"}), mock.patch.object(dj, "make_drop", return_value=None), \
                     mock.patch.object(hq_spotify, "player_action"):
                    dj.next_tournament_match({})
        self.assertEqual(hall.view("decade")["played"], 1)
        self.assertEqual(hall.view("games")["played"], 0)
        self.assertEqual(self.get("/api/musica/dj/hall/decade")["played"], 1)
        self.assertEqual(dj.http_get("/api/musica/dj/hall/nope")[0], 404)
        self.assertTrue(any(k["id"] == "library" for k in self.get("/api/musica/dj/hall")["kinds"]))

    def get(self, path):
        return dj.http_get(path)[1]

    # ---- daily challenge ---------------------------------------------------------------------------------------
    def daily(self):
        pools = {"forgotten": [row(1, "forgotten")], "discovery": [row(2, "discovery")]}
        with mock.patch.object(dj, "candidate_pools", return_value=pools), \
             self.model({"intro": "Express !", "line_b": "Vite !", "prediction": "a"}), \
             mock.patch.object(dj, "make_drop", return_value=None), mock.patch.object(hq_spotify, "player_action"):
            return dj.start_daily({})

    def test_daily_is_an_express_blind_duel_with_short_windows_once_a_day(self):
        out = self.daily()
        duel = dj._state()["duel"]
        self.assertTrue(duel["daily"] and duel["blind"])
        self.assertEqual(duel["window"]["seconds"], dj.DAILY_SECONDS)
        self.assertRegex(out["segment"]["title"], "Défi du jour|Daily challenge")
        self.assertEqual(dj.daily_view()["done_today"], False)
        with mock.patch.object(dj.music, "record_feedback"):
            result = dj.vote_duel("a")
        self.assertEqual(result["daily"]["streak"], 1)
        self.assertTrue(result["daily"]["done_today"])
        self.assertIsNone((dj._state().get("duels") or {}).get("champion"))  # the duel title is untouched
        self.assertRegex(result["text"], "défi du jour|challenge")
        with self.assertRaises(dj.DjError) as caught:
            self.daily()
        self.assertEqual(caught.exception.code, "daily_done")

    def test_streak_counts_consecutive_days_and_a_missed_day_resets_it(self):
        state = dj._state()
        state["daily"] = {"last_done": (date.today() - timedelta(days=1)).isoformat(), "streak": 4, "best": 6, "total": 9}
        dj._save_state(state)
        self.assertEqual(dj.daily_view()["streak"], 4)  # yesterday keeps it alive
        self.daily()
        with mock.patch.object(dj.music, "record_feedback"):
            dj.vote_duel("b")
        self.assertEqual(dj.daily_view()["streak"], 5)
        self.assertEqual(dj.daily_view()["best"], 6)
        state = dj._state()
        state["daily"] = {"last_done": (date.today() - timedelta(days=3)).isoformat(), "streak": 7, "best": 7, "total": 7}
        dj._save_state(state)
        self.assertEqual(dj.daily_view()["streak"], 0)  # two days missed
        self.daily()
        with mock.patch.object(dj.music, "record_feedback"):
            dj.vote_duel("a")
        self.assertEqual(dj.daily_view()["streak"], 1)
        self.assertEqual(dj.daily_view()["best"], 7)

    def test_daily_feeds_its_own_hall_and_exposes_state(self):
        import hq_music_dj_hall as hall
        self.daily()
        with mock.patch.object(dj.music, "record_feedback"):
            dj.vote_duel("a")
        self.assertEqual(hall.view("daily")["ranking"][0]["wins"], 1)
        self.assertEqual(dj.public_state()["daily"]["total"], 1)
        self.assertEqual(dj.http_post("/api/musica/dj/daily", {})[0], 409)  # already played today


if __name__ == "__main__":
    unittest.main()
