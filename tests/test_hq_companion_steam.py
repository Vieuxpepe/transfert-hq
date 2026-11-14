import unittest
from unittest.mock import patch

import hq_companion_steam as steam
import hq_ai as ai
from tests.test_hq_ai import Base, DEV
import json


class SteamContextTests(unittest.TestCase):
    def test_unrelated_chat_does_not_read_library(self):
        with patch.object(steam, "installed_games") as games:
            self.assertEqual(steam.context_for("Bonjour Transferina"), "")
            games.assert_not_called()

    def test_game_context_is_bounded_and_prefers_named_title(self):
        games = ["Game %02d" % i for i in range(30)]
        with patch.object(steam, "installed_games", return_value=games):
            context = steam.context_for("Parlons de mes jeux Steam")
            self.assertIn("Game 19", context)
            self.assertNotIn("Game 20", context)
            context = steam.context_for("Mon jeu Game 25")
            self.assertIn("Game 25", context)
            self.assertNotIn("Game 19", context)

    def test_empty_library_is_not_claimed_as_full_account(self):
        with patch.object(steam, "installed_games", return_value=[]):
            self.assertIn("aucun jeu installé", steam.context_for("Steam"))


class SteamPromptTests(Base):
    def test_only_opted_in_admin_chat_includes_steam_context(self):
        with patch.object(steam, "installed_games", return_value=["Test Game"]):
            ai.transferania_chat("Mes jeux Steam ?", device_id=DEV, role="admin", steam=True)
            self.assertIn("Test Game", json.dumps(self.calls[-1][1]))
            ai.transferania_chat("Mes jeux Steam ?", device_id=DEV, role="admin", steam=False)
            self.assertNotIn("Jeux Steam installés sur ce PC", json.dumps(self.calls[-1][1]))


if __name__ == "__main__":
    unittest.main()
