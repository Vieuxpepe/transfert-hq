"""Complete replies and emoji register, using the isolated fake provider."""
from tests.test_hq_ai import Base, reply, DEV
import hq_ai as ai

class ReadingTests(Base):
    def test_complete_generated_reply_survives_api_and_history(self):
        text = "A useful detail. " * 120 + "COMPLETE END."
        self.answers = [reply(text)]
        code, out = ai.http_post({"action":"transferania", "op":"send", "message":"Explain the detail", "view":"accueil", "persona":"warm", "device_id":DEV})
        self.assertEqual(code, 200, out)
        self.assertEqual(out["reply"], text)
        self.assertEqual(ai.transferania_history(device_id=DEV)["messages"][-1]["text"], text)

    def test_registers_allow_emoji_without_requiring_them(self):
        for register in (ai.CHAT_REGISTER, ai.CHAT_REGISTER_NSFW, ai.AMBIENT_REGISTER, ai.AMBIENT_REGISTER_NSFW):
            self.assertIn("emoji", register.lower())
            self.assertNotIn("ni emoji", register.lower())
