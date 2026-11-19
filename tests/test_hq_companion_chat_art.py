from unittest.mock import patch

import hq_ai as ai
import hq_companion_art as art
import hq_companion_guard as guard
from tests.test_hq_ai import Base, DEV, DEV2, reply


class ChatArtTests(Base):
    def test_forge_submission_uses_active_checkpoint_and_skips_busy_forge(self):
        plan = {"prompt": "quiet library", "sampler": "Euler", "steps": 900, "cfg": 100}
        with patch.object(art.forge, "read_options", return_value={"sd_model_checkpoint": "owner-model"}), patch.object(
            art, "companion_submission_body", wraps=art.companion_submission_body
        ), patch.object(art, "controlnet_status", return_value={}), patch.object(
            art, "_controlnet_units", return_value=[]
        ), patch.object(art.forge, "status", return_value={"forge": "ready"}) as status, patch.object(
            art.forge, "post_json", return_value={"images": ["aW1hZ2U="]}
        ) as post, patch.object(art, "_chat_art_webp", return_value=b"webp"):
            self.assertEqual(art.generate_chat_art(self.root, plan, "warm"), b"webp")
            route, body = post.call_args.args
            self.assertEqual(route, art.forge.SUBMIT_PATH)
            self.assertEqual((body["steps"], body["cfg_scale"], body["batch_size"]), (22, art.DEFAULT_CFG, 1))
            self.assertNotIn("override_settings", body)
            gift = {**plan, "presentation": "bubble", "framing": "landscape", "steps": 5}
            self.assertEqual(art.generate_chat_art(self.root, gift, "warm"), b"webp")
            gift_body = post.call_args.args[1]
            self.assertEqual((gift_body["width"], gift_body["height"], gift_body["steps"]), (320, 256, 5))
            self.assertEqual(gift_body["alwayson_scripts"], {})
            status.return_value = {"forge": "busy"}
            with self.assertRaises(art.CompanionArtError):
                art.generate_chat_art(self.root, plan, "warm")
            self.assertEqual(post.call_count, 2)

    def test_model_recipe_becomes_private_attachment_and_respects_cooldown(self):
        directive = (
            'Une lumière qui te plairait.\n[forge-image:{"prompt":"rainy rooftop, '
            'purple coat","presentation":"bubble","framing":"landscape","sampler":"Euler","steps":5,"cfg":5,"seed":19}]'
        )
        self.answers = [reply(directive), reply(directive), reply(directive)]
        workers = []
        with patch.object(ai.hq_life, "spawn", side_effect=workers.append), patch.object(
            art, "generate_chat_art", return_value=b"webp"
        ) as generate:
            code, response = ai.http_post(
                {"action": "transferania", "message": "Bonsoir", "view": "intime",
                 "device_id": DEV, "chat_art": True},
                role="admin", owner_id="art-owner",
            )
            self.assertEqual(code, 200, response)
            # The reply guard owns the opening now: an article-led line is prefixed,
            # so the payload cannot start on "Une"; the sentence itself is preserved.
            self.assertFalse(guard.opens_on_article(response["reply"]), response["reply"])
            self.assertIn("une lumière qui te plairait.", response["reply"].lower())
            art_id = response["chat_art_id"]
            self.assertTrue(ai.http_get({"chat_art": [art_id], "device_id": [DEV]},
                                        role="admin", owner_id="art-owner")[1]["pending"])
            workers[0]()
            recipe = art.chat_art_recipe(generate.call_args.args[1], "thoughtful", self.root)
            self.assertIn("(frowning:1.5)", recipe["prompt"])
            self.assertIn("rainy rooftop", recipe["prompt"])
            self.assertEqual((recipe["width"], recipe["height"], recipe["steps"], recipe["seed"]),
                             (320, 256, 5, 19))
            path = ai.transferania_chat_image(art_id, DEV, owner_id="art-owner")
            self.assertEqual(path.suffix, ".webp")
            self.assertEqual(path.read_bytes(), b"webp")
            legacy = path.rename(path.with_suffix(".jpg"))
            self.assertEqual(ai.transferania_chat_image(art_id, DEV, owner_id="art-owner"), legacy)
            self.assertIsNone(ai.transferania_chat_image(art_id, DEV2, owner_id="art-owner"))
            self.assertIsNone(ai.transferania_chat_image(art_id, DEV, owner_id="other-owner"))
            _, saved = ai.http_get({"transferania": ["1"], "device_id": [DEV]},
                                   role="admin", owner_id="art-owner")
            self.assertIn(art_id, saved["messages"][-1]["photo_href"])
            self.assertEqual(saved["messages"][-1]["chat_art_presentation"], "bubble")
            _, second = ai.http_post(
                {"action": "transferania", "message": "Et ensuite ?", "view": "intime",
                 "device_id": DEV, "chat_art": True},
                role="admin", owner_id="art-owner",
            )
            self.assertNotIn("chat_art_id", second)
            generate.assert_called_once()
            self.clock[0] += 13 * 60
            _, third = ai.http_post(
                {"action": "transferania", "message": "Et maintenant ?", "view": "intime",
                 "device_id": DEV, "chat_art": True},
                role="admin", owner_id="art-owner",
            )
            self.assertIn("chat_art_id", third)
            workers[-1]()
