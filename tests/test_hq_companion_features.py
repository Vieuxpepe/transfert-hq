"""Transferania extras (perf6): lasting facts, memory commands, thread backups, retry/edit, nudge, stats.

Fake Gemini and a temp root only (Base from test_hq_ai): no network, no live state."""
import json
import sys
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import hq_ai as ai  # noqa: E402
from test_hq_ai import Base, reply, DEV  # noqa: E402


def T(op, **kw):
    return ai.http_post({"action": "transferania", "op": op, "device_id": DEV, **kw})


class FeatureBase(Base):
    def send(self, text, **kw):
        return T("send", message=text, persona="warm", **kw)

    def thread(self):
        return json.loads(ai._thread_path(DEV).read_text("utf-8"))

    def prompt_text(self, call):
        body = call[1]
        return json.dumps(body.get("systemInstruction"), ensure_ascii=False) + json.dumps(body.get("contents"), ensure_ascii=False)

    def chat_calls(self):
        return [c for c in self.calls if "transferania" in json.dumps(c[1], ensure_ascii=False).lower() or True]


class FactsTests(FeatureBase):
    def test_crud_and_cap(self):
        code, out = T("fact_add", text="  Aime le café   noir ")
        self.assertEqual(code, 200, out)
        fid = out["fact"]["id"]
        self.assertEqual(out["fact"]["text"], "Aime le café noir")
        self.assertEqual(out["fact"]["at"], "2026-11-01")
        code, out = T("fact_add", text="aime le CAFE noir")
        self.assertTrue(out.get("duplicate"))
        code, out = T("fact_edit", id=fid, text="Aime le thé vert")
        self.assertEqual(out["fact"]["text"], "Aime le thé vert")
        code, out = T("facts")
        self.assertEqual([f["text"] for f in out["facts"]], ["Aime le thé vert"])
        code, out = T("fact_delete", id=fid)
        self.assertEqual((code, out["facts"]), (200, []))
        self.assertEqual(T("fact_delete", id=fid)[0], 404)
        for i in range(ai.FACTS_MAX):
            self.assertEqual(T("fact_add", text=f"fait numéro {i}")[0], 200)
        code, out = T("fact_add", text="un de trop")
        self.assertEqual((code, out["code"]), (409, "facts_full"))
        self.assertEqual(len(T("facts")[1]["facts"]), ai.FACTS_MAX)
        self.assertEqual(T("fact_add", text="   ")[0], 400)

    def test_corrupt_facts_are_kept_and_never_overwritten(self):
        p = ai._facts_path(DEV)
        p.parent.mkdir(parents=True)
        p.write_text("{pas du json", "utf-8")
        code, out = T("facts")
        self.assertTrue(out["unreadable"])
        self.assertTrue(list(p.parent.glob(p.name + ".corrupt-*")))
        self.assertEqual(T("fact_add", text="x y z")[1]["code"], "facts_unreadable")
        self.assertEqual(p.read_text("utf-8"), "{pas du json")
        self.answers = [reply("Salut toi.")]
        code, out = self.send("Bonjour")
        self.assertEqual(code, 200, out)
        self.assertFalse(out["fallback"])

    def test_facts_reach_the_prompt(self):
        T("fact_add", text="Promesse : on regarde Dune samedi")
        self.answers = [reply("Avec plaisir.")]
        code, out = self.send("Tu fais quoi ce soir ?")
        self.assertEqual(code, 200, out)
        self.assertIn("FAITS DURABLES", self.prompt_text(self.calls[-1]))
        self.assertIn("on regarde Dune samedi", self.prompt_text(self.calls[-1]))
        code, out = ai.http_get({"transferania": ["1"], "device_id": [DEV]})
        self.assertEqual(out["facts"][0]["text"], "Promesse : on regarde Dune samedi")


class MemoryCommandTests(FeatureBase):
    def test_remember_recall_forget_without_model(self):
        code, out = self.send("souviens-toi : j'adore les chats tigrés")
        self.assertEqual(code, 200, out)
        self.assertTrue(out["local"])
        self.assertIn("j'adore les chats tigrés", out["reply"])
        code, out = self.send("Souviens-toi que mon cours de statique est le jeudi")
        code, out = self.send("De quoi tu te souviens ?")
        self.assertIn("• j'adore les chats tigrés", out["reply"])
        self.assertIn("• mon cours de statique est le jeudi", out["reply"])
        code, out = self.send("oublie : chats")
        self.assertIn("j'ai oublié", out["reply"])
        self.assertEqual([f["text"] for f in T("facts")[1]["facts"]], ["mon cours de statique est le jeudi"])
        code, out = self.send("forget: licorne")
        self.assertIn("rien trouvé", out["reply"])
        self.assertEqual(self.calls, [], "memory commands never call the model")
        kinds = [m.get("kind") for m in self.thread()["messages"] if m["role"] == "assistant"]
        self.assertEqual(kinds, ["memory"] * 5)

    def test_empty_recall_and_ordinary_sentences(self):
        code, out = self.send("what do you remember about me?")
        self.assertIn("aucun fait durable", out["reply"])
        self.answers = [reply("Bien sûr.")]
        code, out = self.send("Tu te souviens de notre balade au parc ?")
        self.assertFalse(out.get("local"), "a normal question still goes to the model")
        self.assertEqual(len(self.calls), 1)

    def test_unreadable_thread_refuses_commands(self):
        p = ai._thread_path(DEV)
        p.parent.mkdir(parents=True)
        p.write_text("corrompu", "utf-8")
        code, out = self.send("souviens-toi : x y z")
        self.assertEqual((code, out["code"]), (409, "thread_unreadable"))
        self.assertEqual(T("facts")[1]["facts"], [])


class BackupTests(FeatureBase):
    def day(self, d, h=10):
        self.clock[0] = datetime(2026, 11, d, h, 0).timestamp()

    def test_daily_rolling_backup_and_restore(self):
        self.send("souviens-toi : premier")  # creates the thread: nothing to back up yet
        bdir = ai._thread_backup_dir(DEV)
        self.assertFalse(bdir.exists() and list(bdir.iterdir()))
        self.send("souviens-toi : deuxième")
        first = bdir / f"{DEV}.20261101.json"
        self.assertTrue(first.exists())
        snap = first.read_bytes()
        self.send("souviens-toi : troisième")
        self.assertEqual(first.read_bytes(), snap, "at most one backup per day")
        for d in range(2, 11):
            self.day(d)
            self.send(f"souviens-toi : jour {d}")
        names = [b["name"] for b in T("backups")[1]["backups"]]
        self.assertEqual(len(names), ai.THREAD_BACKUP_KEEP)
        self.assertEqual(names[0], f"{DEV}.20261110.json")
        before = ai._thread_path(DEV).read_bytes()
        code, out = T("backup_restore", name=names[-1])
        self.assertEqual(code, 200, out)
        self.assertEqual(ai._thread_path(DEV).read_bytes(), (bdir / names[-1]).read_bytes())
        aside = ai._thread_path(DEV).parent / out["previous_copy"]
        self.assertEqual(aside.read_bytes(), before)
        self.assertEqual(T("backup_restore", name="../../x.json")[0], 400)
        self.assertEqual(T("backup_restore", name=f"{DEV}.20200101.json")[0], 404)

    def test_corrupt_thread_is_never_backed_up(self):
        p = ai._thread_path(DEV)
        p.parent.mkdir(parents=True)
        p.write_text("corrompu", "utf-8")
        ai._maybe_backup_thread(DEV)
        self.assertFalse(ai._thread_backup_dir(DEV).exists())
        self.assertEqual(T("backups")[1]["backups"], [])

    def test_restore_refused_while_busy(self):
        self.send("souviens-toi : a")
        self.send("souviens-toi : b")
        name = T("backups")[1]["backups"][0]["name"]
        key = str(ai._cb.get("root", "")) + ":" + ai.companion_memory.current_owner() + ":" + DEV
        ai._companion_active.add(key)
        try:
            self.assertEqual(T("backup_restore", name=name)[1]["code"], "companion_busy")
        finally:
            ai._companion_active.discard(key)


class RetryEditTests(FeatureBase):
    def assistant_texts(self):
        return [m["text"] for m in self.thread()["messages"] if m["role"] == "assistant"]

    def test_regenerate_replaces_last_reply(self):
        self.answers = [reply("Première version.")]
        self.send("Raconte-moi ta journée")
        self.answers = [reply("Deuxième version.")]
        code, out = T("regenerate", persona="warm")
        self.assertEqual(code, 200, out)
        self.assertTrue(out["regenerated"])
        msgs = self.thread()["messages"]
        self.assertEqual([m["role"] for m in msgs], ["user", "assistant"])
        self.assertEqual(msgs[0]["text"], "Raconte-moi ta journée")
        self.assertEqual(msgs[1]["text"], "Deuxième version.")

    def test_edit_last_replaces_message_and_drops_replies(self):
        self.answers = [reply("Réponse A.")]
        self.send("Message avec une fote")
        self.answers = [reply("Réponse B.")]
        code, out = T("edit_last", message="Message corrigé", persona="warm")
        self.assertEqual(code, 200, out)
        msgs = self.thread()["messages"]
        self.assertEqual([(m["role"], m["text"]) for m in msgs], [("user", "Message corrigé"), ("assistant", "Réponse B.")])
        self.assertEqual(T("edit_last", message="   ")[0], 400)
        self.assertEqual(len(self.thread()["messages"]), 2)

    def test_guards_keep_thread_intact(self):
        self.assertEqual(T("regenerate")[1]["code"], "nothing_to_retry")
        self.answers = [reply("Salut.")]
        self.send("Coucou")
        before = self.thread()["messages"]
        key = str(ai._cb.get("root", "")) + ":" + ai.companion_memory.current_owner() + ":" + DEV
        ai._companion_active.add(key)
        try:
            self.assertEqual(T("regenerate")[1]["code"], "companion_busy")
        finally:
            ai._companion_active.discard(key)
        ai.bind(key=lambda: "")
        self.assertEqual(T("regenerate")[1]["code"], "no_key")
        self.assertEqual(self.thread()["messages"], before)
        ai.bind(key=lambda: "test-key")
        p = ai._thread_path(DEV)
        p.write_text("corrompu", "utf-8")
        self.assertEqual(T("regenerate")[1]["code"], "thread_unreadable")
        self.assertEqual(p.read_text("utf-8"), "corrompu")

    def test_failed_resend_restores_exchange(self):
        self.answers = [reply("Salut.")]
        self.send("Coucou")
        before = self.thread()["messages"]
        code, out = T("edit_last", message="x" * (ai.TRANSFERANIA_MSG_MAX + 1))
        self.assertEqual(code, 400)
        self.assertEqual(self.thread()["messages"], before)


class NudgeTests(FeatureBase):
    def history(self):
        return ai.http_get({"transferania": ["1"], "device_id": [DEV]})[1]

    def nudges(self):
        return [m for m in self.thread()["messages"] if m.get("kind") == "nudge"]

    def test_off_by_default_then_once_per_day(self):
        self.answers = [reply("Salut.")]
        self.send("Coucou")
        self.assertFalse(ai.default_transferania_prefs()["nudge"])
        self.clock[0] += 7 * 3600  # 17:00
        self.assertFalse(self.history()["nudged"])
        self.assertEqual(self.nudges(), [])
        T("prefs", save=True, prefs={"nudge": True})
        self.assertTrue(self.history()["nudged"])
        self.assertFalse(self.history()["nudged"], "at most one per day")
        self.assertEqual(len(self.nudges()), 1)
        self.assertEqual(self.nudges()[0]["role"], "assistant")
        self.assertIn(self.nudges()[0]["text"], ai.NUDGE_LINES)

    def test_silence_hours_and_busy(self):
        T("prefs", save=True, prefs={"nudge": True})
        self.answers = [reply("Salut.")]
        self.send("Coucou")  # 10:00
        self.clock[0] += 3 * 3600
        self.assertFalse(self.history()["nudged"], "needs 6 h of silence")
        self.clock[0] = datetime(2026, 11, 1, 22, 0).timestamp()
        self.assertFalse(self.history()["nudged"], "not after 21:30")
        self.clock[0] = datetime(2026, 11, 2, 8, 30).timestamp()
        self.assertFalse(self.history()["nudged"], "not before 09:00")
        self.clock[0] = datetime(2026, 11, 2, 9, 5).timestamp()
        key = str(ai._cb.get("root", "")) + ":" + ai.companion_memory.current_owner() + ":" + DEV
        ai._companion_active.add(key)
        try:
            self.assertFalse(self.history()["nudged"], "never while a chat is in flight")
        finally:
            ai._companion_active.discard(key)
        self.assertTrue(self.history()["nudged"])

    def test_no_nudge_on_empty_thread(self):
        T("prefs", save=True, prefs={"nudge": True})
        self.assertFalse(self.history()["nudged"])


class StatsTests(FeatureBase):
    def test_stats_from_context_usage(self):
        ai.bind(companion_context_config=lambda: {"prices_per_million": {"gemini-3.5-flash-lite": {"input": 1.0, "output": 2.0}}})
        self.answers = [(200, {"candidates": [{"content": {"parts": [{"text": "Salut."}]}, "finishReason": "STOP"}],
                               "usageMetadata": {"promptTokenCount": 1000, "candidatesTokenCount": 500, "totalTokenCount": 1500}})]
        self.send("Coucou")
        self.send("souviens-toi : un fait")
        code, out = T("stats")
        self.assertEqual(code, 200, out)
        self.assertEqual(out["count"], 2)
        self.assertEqual(out["recent"][0]["model"], "local")
        self.assertEqual(out["recent"][1]["model"], ai.CHAT_CHAIN[0])
        self.assertAlmostEqual(out["cost_today"], 0.002)
        self.assertEqual(out["model_mix"], {"local": 1, ai.CHAT_CHAIN[0]: 1})
        self.assertIsNotNone(out["median_latency_ms"])
        rows = json.loads((self.root / ai.STORE / "context-usage.json").read_text("utf-8"))
        self.assertIsInstance(rows, list)

    def test_missing_or_corrupt_usage(self):
        self.assertEqual(T("stats")[1]["count"], 0)
        (self.root / ai.STORE).mkdir(exist_ok=True)
        (self.root / ai.STORE / "context-usage.json").write_text("[[[", "utf-8")
        self.assertEqual(T("stats")[1]["median_latency_ms"], None)

    def test_inflected_memory_bridge_reflection_and_capture_handoff(self):
        # 1. Stemming in companion_memory and companion_context
        self.assertTrue(ai.companion_memory.terms("soudure") & ai.companion_memory.terms("souder"))
        self.assertTrue(ai.companion_context.terms("peintures") & ai.companion_context.terms("peinture"))
        # 2. Facts bridge across devices (souviens-toi on DEV -> recalled on DEV2)
        code, out = self.send("souviens-toi : j'adore souder l'acier")
        self.assertEqual(code, 200)
        self.assertIn("souviendrai", out["reply"])
        code, out2 = T("send", device_id="device_beta_987654", message="de quoi tu te souviens ?")
        self.assertEqual(code, 200)
        self.assertIn("j'adore souder l'acier", out2["reply"])
        # 3. Actionable message triggers suggest_capture handoff
        code, out_cap = self.send("Il faut que je commande 20 vis M4 d'ici demain")
        self.assertEqual(code, 200)
        self.assertEqual(out_cap.get("suggest_capture"), "Il faut que je commande 20 vis M4 d'ici demain")
        self.assertEqual(out_cap["messages"][-1].get("suggest_capture"), "Il faut que je commande 20 vis M4 d'ici demain")
        # 4. Reflection hint reaches live chat VOIX TRANSFERANIA block
        code, prev = ai.http_post({"action": "transferania", "op": "context_preview", "device_id": DEV, "channel": "chat", "message": "Salut", "signals": {"interactions": ["caresse joue"]}}, role="admin")
        self.assertEqual(code, 200)
        user_text = prev["contents"][-1]["parts"][0]["text"]
        self.assertIn("VOIX TRANSFERANIA", user_text)
        self.assertIn("Écho tactile Live2D", user_text)

    def test_unconstrained_agency_vision_archive_and_briefing(self):
        # 1. Live HQ lookup detection + inline action proposals
        self.assertTrue(ai.wants_hq_lookup("Il me reste combien de vis M4 en stock ?"))
        props_stock = ai.extract_inline_proposals("J'ai acheté 20 vis M4")
        self.assertEqual(len(props_stock), 1)
        self.assertEqual(props_stock[0]["kind"], "stock")
        self.assertEqual(props_stock[0]["delta"], 20.0)

        code, out_prop = self.send("Il faut que je commande du flux demain")
        self.assertEqual(code, 200)
        self.assertTrue(out_prop.get("proposals"))
        self.assertEqual(out_prop["proposals"][0]["kind"], "task")

        # 2. Multimodal image attachment in chat
        tiny_png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        self.answers = [reply("Je vois un pixel.")]
        code, out_img = T("send", message="Que vois-tu sur ce schéma ?", image=tiny_png)
        self.assertEqual(code, 200)
        self.assertTrue(out_img["messages"][-2].get("has_image"))
        last_call_parts = self.calls[-1][1]["contents"][-1]["parts"]
        self.assertTrue(any("inlineData" in p for p in last_call_parts))

        # 3. Semantic SQLite Archive indexing and search
        chunk = [
            {"role": "user", "text": "Nous avons calibré l'oscilloscope Tektronix sur 50 MHz", "ts": 1700000000000},
            {"role": "assistant", "text": "Parfait, le signal carré sur l'oscilloscope Tektronix est net.", "ts": 1700000005000},
        ]
        added = ai.companion_archive.archive_exchanges(chunk, DEV)
        self.assertEqual(added, 1)
        code, arch_out = T("archive_search", query="calibrer oscilloscope Tektronix")
        self.assertEqual(code, 200)
        self.assertTrue(arch_out["results"])
        self.assertIn("Tektronix", arch_out["results"][0]["user_text"])

        # 4. Workshop Briefing ("Table d'atelier")
        code, brief_out = T("briefing")
        self.assertEqual(code, 200)
        self.assertIn("Table d'atelier", brief_out["briefing"])

        # 5. Viseme envelope computation on a synthetic WAV
        import wave, math, struct, hq_voice
        wav_file = self.root / "test_viseme.wav"
        with wave.open(str(wav_file), "wb") as wf:
            wf.setnchannels(1)
            wf.setsampwidth(2)
            wf.setframerate(16000)
            samples = [int(12000 * math.sin(2 * math.pi * 440 * i / 16000)) for i in range(8000)]
            wf.writeframes(struct.pack("<" + "h" * len(samples), *samples))
        vis = hq_voice.compute_viseme_envelope(wav_file, fps=30)
        self.assertTrue(len(vis) >= 10)
        self.assertTrue(any(v["a"] > 0.1 and v["v"] != "sil" for v in vis))

    def test_sister_gifts_thoughts_and_souvenirs(self):
        # 1. Inner Monologue / Journal Intime d'Atelier (hq_life + hq_ai)
        code, th_add = T("thought_add", text="Je veille sur l'établi pendant que Marco soude.", kind="atelier")
        self.assertEqual(code, 200)
        self.assertTrue(th_add.get("ok"))
        code, th_out = T("thoughts")
        self.assertEqual(code, 200)
        self.assertTrue(th_out["current"])
        self.assertTrue(any("soude" in t["text"] for t in th_out["thoughts"]))

        # Pulse and history include her current thought
        code, p_out = ai.http_post({"action": "pulse", "device_id": DEV, "view": "accueil"}, role="admin")
        self.assertEqual(code, 200)
        self.assertIn("thought", p_out)
        self.assertTrue(p_out["thought"])
        code, hist = T("history")
        self.assertEqual(code, 200)
        self.assertIn("thought", hist)

        # 2. Visual Memory Polaroids / Souvenirs Épinglés
        code, pin_out = T("souvenir_pin", text="Notre premier test d'oscilloscope réussi ♥", photo_href="/assets/companion/chat/test.jpg", view="forge")
        self.assertEqual(code, 200)
        self.assertTrue(pin_out.get("ok"))
        sv_id = pin_out["souvenir"]["id"]
        self.assertEqual(pin_out["souvenir"]["view"], "forge")

        code, sv_list = T("souvenirs")
        self.assertEqual(code, 200)
        self.assertEqual(len(sv_list["souvenirs"]), 1)
        self.assertEqual(sv_list["souvenirs"][0]["id"], sv_id)

        code, del_out = T("souvenir_delete", id=sv_id)
        self.assertEqual(code, 200)
        self.assertEqual(len(del_out["souvenirs"]), 0)


if __name__ == "__main__":
    unittest.main()