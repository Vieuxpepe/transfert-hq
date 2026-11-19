"""The assistant (hq_ai.py) with a fake Gemini: context, model fallback, quotas, proposals checked and applied."""
import json
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import hq_ai as ai
from tests import hq_assistant_state  # noqa: E402

DEV = "hqtestdevice01ab"
DEV2 = "hqtestdevice02xy"


def reply(text, thought=None, finish_reason="STOP"):
    parts = ([{"text": thought, "thought": True}] if thought else []) + [{"text": text}]
    cand: dict = {"content": {"parts": parts}, "finishReason": finish_reason}
    return 200, {"candidates": [cand]}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = []
        self.answers = []
        self.written = []
        self.clock = [datetime(2026, 11, 1, 10, 0).timestamp()]
        self.projects = {"projects": [{"id": "prj-a", "name": "Bras robot", "status": "active", "goal": "Un bras 4 axes", "resume": "Imprimer la base",
                                       "milestones": [{"title": "Base imprimée", "due": "2026-11-10", "done": False}], "bom": []}],
                         "tasks": [{"id": "c-1", "title": "Commander servos", "project": "prj-a", "column": "todo"}, {"id": "c-2", "title": "Ranger le bureau", "column": "todo"}]}
        self.inv = {"places": [{"id": "plc-1", "name": "Atelier", "parent": None}, {"id": "plc-2", "name": "Tiroir B2", "parent": "plc-1", "code": "B2"}],
                    "items": [{"id": "itm-1", "name": "Vis M3 x 10", "qty": 12, "unit": "", "place": "plc-2", "min": 20, "tags": ["visserie"]}]}

        def post(url, body, headers, timeout):
            self.calls.append((url.split("/models/")[1].split(":")[0], body, headers))
            return self.answers.pop(0) if self.answers else reply("ok")

        ai._minute.clear()
        ai._health.clear()
        ai.bind(companion_context_config=lambda: {}, root=self.root, extra_keys=lambda: [], key=lambda: "test-key", now=lambda: self.clock[0], post=post,
                nvidia_key=lambda: "", nim_fallback=lambda: False, local_llm=lambda: False, local_llm_call=None,
                companion_persona=lambda: "flirt",
                client_is_controller=lambda ip: str(ip).startswith("127.") or ip == "::1",
                nsfw_enabled=lambda: True,
                calendar=lambda a, b: [{"title": "Labo GIA1077", "start": "2026-11-05T14:00", "end": "2026-11-05T16:00", "category": "study"}],
                projects=lambda: self.projects, inventory=lambda: self.inv,
                carnet=lambda: {"pages": [{"id": "page-1", "title": "Statique ch. 4", "text": "Moment d'inertie : I = somme y² dA", "block": "block-1", "updated": 1}]},
                files=lambda ws: ["Uni/GIA1077/plan-bras.pdf"] if "bras" in ws else [],
                save_event=lambda p: self.written.append(("event", p)), projects_apply=lambda d: self.written.append(("projects", d)) or {},
                inventory_apply=lambda d: self.written.append(("inventory", d)) or {"item": {"id": "itm-9"}},
                carnet_note=lambda lines: self.written.append(("note", lines)) or {"id": "page-9", "block": "block-9"})
        # Personhood, visit and relationship stores follow the assistant modules,
        # not the AI root: keep them in this test's temp root too.
        hq_assistant_state.bind(self.root)
        hq_assistant_state.guard(self)  # fails the test if a store writes the checkout

    def tearDown(self):
        self.tmp.cleanup()


class AskTests(Base):
    def test_answer_with_context_and_sources(self):
        self.answers = [reply("La base est à imprimer [2], puis commander les servos [2]. Plan : [5]")]
        code, out = ai.http_post({"action": "ask", "q": "Où en est le bras robot ?"})
        self.assertEqual(code, 200, out)
        model, body, headers = self.calls[0]
        self.assertEqual((model, headers["x-goog-api-key"]), ("gemini-3.1-flash-lite", "test-key"))
        prompt = body["contents"][-1]["parts"][0]["text"]
        for bit in ("Labo GIA1077", "Bras robot", "Imprimer la base", "Commander servos", "plan-bras.pdf"):
            self.assertIn(bit, prompt)
        self.assertNotIn("test-key", json.dumps(out), "the key never goes back to the browser")
        kinds = [s["kind"] for s in out["sources"]]
        self.assertIn("project", kinds)
        self.assertEqual(out["sources"][1]["href"], "#projets/prj-a")
        self.assertIn(2, out["cited"])

    def test_busy_models_fall_back_and_thoughts_are_dropped(self):
        self.answers = [(503, {"error": {"message": "high demand"}}), (429, {}), reply("Réponse finale", thought="je réfléchis…")]
        code, out = ai.http_post({"action": "ask", "q": "Bonjour ?"})
        self.assertEqual((code, out["answer"], out["model"]), (200, "Réponse finale", "gemma-4-31b-it"))
        self.assertEqual([c[0] for c in self.calls], list(ai.ASK_CHAIN))

    def test_daily_quota_is_respected(self):
        (self.root / ai.STORE).mkdir()
        (self.root / ai.STORE / ai.USAGE).write_text(json.dumps({"day": "2026-11-01", "count": {"gemini-3.1-flash-lite": 500}}))
        self.answers = [reply("ok")]
        ai.http_post({"action": "ask", "q": "test ?"})
        self.assertEqual(self.calls[0][0], "gemini-3.5-flash-lite", "a used-up model is skipped")
        self.assertEqual(ai.usage()["count"]["gemini-3.5-flash-lite"], 1)
        self.clock[0] += 86400
        self.assertEqual(ai.usage()["count"], {}, "a new day starts from zero")

    def test_visit_quota_is_separate_from_chat_and_ambient(self):
        self.answers = [reply("visite")]
        text, model = ai.generate(
            ("gemini-3.1-flash-lite",), "system", [{"role": "user", "parts": [{"text": "x"}]}],
            visit=True, max_tokens=360,
        )
        self.assertEqual((text, model), ("visite", "gemini-3.1-flash-lite"))
        st = ai.status()
        self.assertEqual(st["visits"], {"used": 1, "per_day": ai.VISIT_DAILY})
        self.assertEqual(st["transferania"]["used"], 0)
        self.assertEqual(st["ambient"]["used"], 0)

    def test_visit_quota_stops_before_the_provider_call(self):
        (self.root / ai.STORE).mkdir()
        (self.root / ai.STORE / ai.USAGE).write_text(json.dumps({
            "day": "2026-11-01", "count": {}, "visits": ai.VISIT_DAILY,
        }))
        with self.assertRaises(ai.AiError) as caught:
            ai.generate(("gemini-3.1-flash-lite",), "system",
                        [{"role": "user", "parts": [{"text": "x"}]}], visit=True)
        self.assertEqual((caught.exception.status, caught.exception.code), (429, "visit_quota"))
        self.assertEqual(self.calls, [])

    def test_no_key(self):
        ai.bind(key=lambda: "")
        code, out = ai.http_post({"action": "ask", "q": "x ?"})
        self.assertEqual((code, out["code"]), (503, "no_key"))
        self.assertFalse(ai.status()["configured"])


class CaptureTests(Base):
    def test_one_sentence_many_actions_checked(self):
        self.answers = [reply(json.dumps({"reply": "Noté.", "actions": [
            {"kind": "event", "title": "Labo GIA1077", "start": "2026-11-05T14:00", "end": "", "all_day": False, "category": "study"},
            {"kind": "stock", "item": "itm-1", "delta": 20},
            {"kind": "task", "title": "Imprimer support", "project": "prj-a", "due": "2026-11-08"},
            {"kind": "note", "text": "ignored, only 3"}]}))]
        code, out = ai.http_post({"action": "capture", "text": "Labo jeudi 14h, acheté 20 vis, imprimer le support du bras"})
        self.assertEqual(code, 200, out)
        self.assertEqual(self.calls[0][0], "gemma-4-26b-a4b-it")
        self.assertIn("itm-1=Vis M3", self.calls[0][1]["systemInstruction"]["parts"][0]["text"])
        p = out["proposals"]
        self.assertEqual(len(p), 3)
        self.assertEqual(p[0]["end"], "2026-11-05T15:00", "an hour when no end is given")
        self.assertIn("(→ 32)", p[1]["label"])
        self.assertIn("Bras robot", p[2]["label"])
        self.assertEqual(self.written, [], "nothing is written before the confirmation")

    def test_unknown_ids_are_refused(self):
        self.answers = [reply('```json\n{"actions":[{"kind":"project_note","project":"prj-zzz","text":"x"},{"kind":"stock","item":"itm-404","delta":-3}]}\n```')]
        out = ai.http_post({"action": "capture", "text": "x"})[1]
        self.assertEqual(out["proposals"], [])
        self.assertEqual(len(out["refused"]), 2)

    def test_apply_writes_through_each_module(self):
        props = [ai.normalize(a, ai._capture_lists("")[3]) for a in [
            {"kind": "event", "title": "Dentiste", "start": "2026-11-03", "all_day": True, "category": "appointment"},
            {"kind": "project_note", "project": "prj-a", "text": "Base imprimée", "mode": "append"},
            {"kind": "stock", "item": None, "name": "Servo MG996R", "delta": 4, "place": "plc-2"}]]
        code, out = ai.http_post({"action": "apply", "proposals": props})
        self.assertEqual(code, 200, out)
        kinds = [w[0] for w in self.written]
        self.assertEqual(kinds, ["event", "projects", "inventory"])
        self.assertEqual(self.written[0][1]["end"], "2026-11-04")
        self.assertEqual(self.written[1][1], {"action": "project.resume", "id": "prj-a", "text": "Imprimer la base\nBase imprimée"})
        self.assertEqual(self.written[2][1]["action"], "item.create")
        self.assertEqual(out["done"][2]["href"], "#inventaire/objet/itm-9")
        code, out = ai.http_post({"action": "apply", "proposals": [{"kind": "note", "text": "Idée\nsupport téléphone"}]})
        self.assertEqual(self.written[-1], ("note", ["Idée", "support téléphone"]))
        self.assertEqual(out["done"][0]["href"], "#carnet/page-9/block-9")

    def test_apply_rechecks_and_reports(self):
        code, out = ai.http_post({"action": "apply", "proposals": [{"kind": "stock", "item": "itm-404", "delta": 1}]})
        self.assertEqual((code, len(out["failed"])), (400, 1))
        self.assertEqual(ai.http_post({"action": "apply", "proposals": []})[0], 400)
        self.assertEqual(ai.http_post({"action": "nope"})[0], 400)


class PureTests(unittest.TestCase):
    def test_helpers(self):
        self.assertEqual(ai.words("Où sont mes vis M3 ?"), ["vis"])
        self.assertEqual(ai.words("Résumé des notes de GIA1077"), ["resume", "notes", "gia1077"])
        self.assertEqual(ai.extract_json('voilà : {"a": 1} merci'), {"a": 1})
        with self.assertRaises(ai.AiError):
            ai.extract_json("rien")

    def test_transferania_split_and_compress(self):
        msgs = [{"role": "user", "text": f"m{i}"} for i in range(25)]
        old, kept = ai.split_over_keep(msgs, 20)
        self.assertEqual(len(old), 5)
        self.assertEqual(len(kept), 20)
        summary = ai.compress_chunk_deterministic("deja", old)
        self.assertIn("deja", summary)
        self.assertIn("m0", summary)

    def test_personality_prefs_and_system(self):
        p = ai.normalize_transferania_prefs({"nickname": " Cap ", "address": "vous", "qc_dial": "medium", "intensity": 9, "topics_off": ["a", "b"], "celebrate": True})
        self.assertEqual(p["nickname"], "Cap")
        self.assertEqual(p["address"], "vous")
        self.assertEqual(p["intensity"], 3)
        self.assertEqual(len(p["topics_off"]), 2)
        sys = ai.build_transferania_system("chat", "flirt", nsfw=False, view="carnet", device_id=DEV, prefs=p, signals={"celebrate": "Note enregistrée"}, summary="Il aime le café.")
        self.assertIn("Transferania", sys)
        self.assertIn("Muse", sys)
        self.assertIn("Cap", sys)
        self.assertIn("MÉMOIRE", sys)
        self.assertIn("Note enregistrée", sys)
        self.assertIn("PRIORITÉ", sys)
        self.assertIn("FAITS", sys)

    def test_nsfw_system_uses_adult_blocks(self):
        sys = ai.build_transferania_system("chat", "warm", nsfw=True, view="fichiers", device_id=DEV, signals={"escalate": "plus direct"}, summary="")
        self.assertIn("FAITS (mode adulte)", sys)
        self.assertIn("REGISTRE CHAT ADULTE", sys)
        self.assertIn("PRIORITÉ (mode adulte)", sys)
        self.assertIn("Intensité adulte", sys)

    def test_extract_companion_photo(self):
        allowed = {"warm": "warm.jpg", "soft": "soft.jpg"}
        text, pid = ai.extract_companion_photo("Tu me fais bander. [photo:warm]", allowed=allowed)
        self.assertEqual(pid, "warm")
        self.assertEqual(text, "Tu me fais bander.")
        text2, pid2 = ai.extract_companion_photo("Salut [photo:nope]", allowed=allowed)
        self.assertIsNone(pid2)
        self.assertEqual(text2, "Salut")
        self.assertIn("warm", ai.companion_chat_photo_prompt(allowed))

    def test_extract_companion_fx_and_segments(self):
        allowed = {"warm": "warm.jpg"}
        loops = {"tease-bob": ""}
        clean, photo, loop, fx = ai.extract_companion_chat_media(
            "Coucou [photo:warm] [fx:kiss] [loop:tease-bob]", photo_allowed=allowed, loop_allowed=loops
        )
        self.assertEqual(clean, "Coucou")
        self.assertEqual(photo, "warm")
        self.assertEqual(loop, "tease-bob")
        self.assertEqual(fx, "kiss")
        segs = ai.split_reply_segments("Partie un. Partie deux longue " + "x" * 200)
        self.assertGreaterEqual(len(segs), 2)

    def test_warmth_and_facts(self):
        ai.bump_warmth(DEV, 5)
        self.assertGreaterEqual(ai.load_transferania_prefs(DEV).get("warmth"), 5)
        data = ai.load_transferania(DEV)
        ai.merge_thread_facts(data, "J'adore les poses archées", "Tu veux encore?")
        self.assertTrue(any("poses" in f.lower() or "adore" in f.lower() for f in data.get("facts") or []))
        self.assertTrue(data.get("open_thread"))


class AmbientTests(Base):
    def ambient_post(self, *args, **kwargs):
        out = ai.http_post(*args, **kwargs)
        if out[1].get("reason") == "coalescing":
            self.clock[0] += 8
            out = ai.http_post(*args, **kwargs)
        return out

    def test_ambient_returns_line(self):
        self.answers = [reply("Forge ouverte — tu vas briller.")]
        code, out = self.ambient_post({"action": "ambient", "view": "forge", "digest": "Vue : Forge", "persona": "warm", "device_id": DEV})
        self.assertEqual(code, 200, out)
        self.assertIn("line", out)
        self.assertFalse(out.get("fallback"))
        self.assertEqual(out["persona"], "warm")

    def test_ambient_off_is_fallback_without_call(self):
        ai.bind(companion_persona=lambda: "off")
        code, out = self.ambient_post({"action": "ambient", "view": "accueil", "persona": "flirt", "device_id": DEV})
        self.assertEqual(code, 200)
        self.assertTrue(out.get("fallback"))
        self.assertEqual(out["persona"], "off")
        self.assertEqual(self.calls, [])

    def test_flirt_capped_to_warm_on_server(self):
        ai.bind(companion_persona=lambda: "warm")
        self.answers = [reply("Salut.")]
        code, out = self.ambient_post({"action": "ambient", "view": "accueil", "persona": "flirt", "device_id": DEV})
        self.assertEqual(out["persona"], "warm")


    def test_ambient_quota_increments(self):
        self.answers = [reply("Coucou.")]
        self.ambient_post({"action": "ambient", "view": "accueil", "digest": "Vue : Accueil", "persona": "warm", "device_id": DEV})
        st = ai.status()
        self.assertEqual(st["ambient"]["used"], 1)
        self.assertEqual(st["ambient"]["per_day"], ai.AMBIENT_DAILY)


    def test_nsfw_admin_session_only(self):
        ai.bind(nsfw_enabled=lambda: True, client_is_controller=lambda ip: False)
        st = ai.status("100.64.0.1", "upload")
        self.assertFalse(st["nsfw_allowed"])
        self.assertFalse(st.get("session_admin"))
        st2 = ai.status("100.64.0.1", "admin")
        self.assertTrue(st2["nsfw_allowed"])
        self.assertTrue(st2.get("session_admin"))
        self.answers = [reply("Mode admin.")]
        out = self.ambient_post({"action": "ambient", "view": "accueil", "digest": "x", "persona": "flirt", "nsfw": True, "device_id": DEV}, client_ip="100.64.0.1", role="admin")[1]
        self.assertTrue(out.get("nsfw"))
        out2 = self.ambient_post({"action": "ambient", "view": "accueil", "digest": "x", "nsfw": True, "device_id": DEV}, client_ip="100.64.0.1", role="upload")[1]
        self.assertFalse(out2.get("nsfw"))


    def test_preview_dry_nsfw(self):
        code, out = self.ambient_post(
            {"action": "preview", "kind": "ambient", "view": "fichiers", "digest": "Vue: test", "nsfw": True, "device_id": DEV},
            client_ip="127.0.0.1",
            role="admin",
        )
        self.assertEqual(code, 200, out)
        self.assertTrue(out.get("nsfw_active"))
        self.assertIn("dirty talk", out.get("system", "").lower())

    def test_nsfw_truncated_end_heuristic(self):
        self.assertTrue(ai.nsfw_truncated_end("viens me montrer ce que tu as dans le pantalon, je veux sentir le poids de t"))
        self.assertFalse(ai.nsfw_truncated_end("Viens ici. Maintenant."))

    def test_nsfw_ambient_retries_next_model_on_safety_cut(self):
        cut = "Laisse tomber ces écrans et viens me montrer ce que tu as dans le pantalon, je veux sentir le poids de t"
        full = "Laisse tomber ces écrans et viens me montrer ce que tu as dans le pantalon, je veux sentir le poids de ta queue."
        self.answers = [reply(cut, finish_reason="SAFETY"), reply(full)]
        out = self.ambient_post(
            {"action": "ambient", "view": "plus", "digest": "Vue : Système", "persona": "flirt", "nsfw": True, "device_id": DEV},
            client_ip="127.0.0.1",
            role="admin",
        )[1]
        self.assertTrue(out.get("nsfw"))
        self.assertIn("queue", out.get("line", "").lower())
        models = [c[0] for c in self.calls]
        self.assertEqual(models[0], "gemini-3.5-flash-lite")
        self.assertEqual(models[1], "gemma-4-26b-a4b-it")


class TransferaniaTests(Base):
    def test_prefs_persist_on_server(self):
        code, out = ai.http_post({"action": "transferania", "op": "prefs", "save": True, "prefs": {"nickname": "Pilote", "intensity": 1}, "device_id": DEV})
        self.assertEqual(code, 200, out)
        self.assertEqual(out["prefs"]["nickname"], "Pilote")
        st = ai.status(device_id=DEV)
        self.assertEqual(st["personality"]["nickname"], "Pilote")

    def test_threads_isolated_by_device(self):
        self.answers = [reply("Salut device1"), reply("Salut device2")]
        ai.http_post({"action": "transferania", "op": "send", "message": "ping1", "view": "accueil", "digest": "x", "persona": "warm", "device_id": DEV})
        ai.http_post({"action": "transferania", "op": "send", "message": "ping2", "view": "accueil", "digest": "x", "persona": "warm", "device_id": DEV2})
        h1 = ai.transferania_history(device_id=DEV)["messages"]
        h2 = ai.transferania_history(device_id=DEV2)["messages"]
        self.assertEqual(len(h1), 2)
        self.assertEqual(len(h2), 2)
        self.assertIn("ping1", h1[0]["text"])
        self.assertIn("ping2", h2[0]["text"])

    def test_chat_persists_and_replies(self):
        self.answers = [reply("Salut, je me souviens de toi.")]
        code, out = ai.http_post({"action": "transferania", "op": "send", "message": "Bonjour Transferania", "view": "accueil", "digest": "Vue : Accueil", "persona": "warm", "device_id": DEV})
        self.assertEqual(code, 200, out)
        self.assertIn("Salut", out["reply"])
        self.assertTrue(any(m.get("role") == "user" for m in out["messages"]))
        hist = ai.http_get({"transferania": ["1"], "device_id": [DEV]})[1]
        self.assertEqual(len(hist["messages"]), 2)
        self.assertEqual(hist["name"], ai.TRANSFERANIA_NAME)

    def test_nsfw_chat_stores_photo_from_tag(self):
        chat = self.root / "assets" / "companion" / "chat"
        chat.mkdir(parents=True, exist_ok=True)
        (chat / "warm.jpg").write_bytes(b"\xff\xd8\xff")
        self.answers = [reply("Regarde bien. [photo:warm]")]
        code, out = ai.http_post(
            {
                "action": "transferania",
                "op": "send",
                "message": "montre",
                "view": "accueil",
                "digest": "x",
                "persona": "warm",
                "device_id": DEV,
                "nsfw": True,
            },
            client_ip="127.0.0.1",
            role="admin",
        )
        self.assertEqual(code, 200, out)
        self.assertEqual(out.get("photo"), "warm")
        self.assertEqual(out["reply"], "Regarde bien.")
        her = [m for m in out["messages"] if m.get("role") == "assistant"][-1]
        self.assertEqual(her.get("photo"), "warm")
        self.assertEqual(her.get("photo_href"), "/assets/companion/chat/warm.jpg")

    def test_ambient_not_stored_in_chat_history(self):
        self.answers = [reply("Forge ouverte.")]
        ai.http_post({"action": "ambient", "view": "forge", "digest": "Vue : Forge", "persona": "warm", "device_id": DEV})
        hist = ai.transferania_history(device_id=DEV)["messages"]
        self.assertEqual(hist, [])

    def test_celebrate_signal_requires_text(self):
        sig = ai.parse_companion_signals({"celebrate": True})
        self.assertEqual(sig["celebrate"], "")
        sig2 = ai.parse_companion_signals({"celebrate": "Règle enregistrée"})
        self.assertEqual(sig2["celebrate"], "Règle enregistrée")
        sig3 = ai.parse_companion_signals({"ui": {"lecteur": "playing"}, "returning": True, "idle_ambient": True})
        self.assertEqual(sig3["ui"]["lecteur"], "playing")
        self.assertTrue(sig3["returning"])
        self.assertTrue(sig3["idle_ambient"])

    def test_navigation_digest_tag(self):
        ctx = ai.gather_ambient("accueil", "Vue : Accueil\nTitre : Bonjour")
        self.assertIn("(navigation seulement)", ctx)

    def test_recent_ambient_ring(self):
        ai.push_recent_ambient("Ligne un.", DEV)
        ai.push_recent_ambient("Ligne deux.", DEV)
        ai.push_recent_ambient("Ligne trois.", DEV)
        ai.push_recent_ambient("Ligne quatre.", DEV)
        prefs = ai.load_transferania_prefs(DEV)
        self.assertEqual(len(prefs.get("recent_ambient") or []), 3)
        self.assertEqual(prefs["recent_ambient"][-1], "Ligne quatre.")

    def test_retains_twenty_one_source_messages(self):
        ai.bind(key=lambda: "")
        data = ai._empty_transferania()
        for i in range(21):
            data["messages"].append({"role": "user" if i % 2 == 0 else "assistant", "text": f"t{i}", "ts": float(i)})
        ai.maybe_compress(data)
        self.assertEqual(len(data["messages"]), 21)
        self.assertFalse(data.get("summary"))

    def test_retains_101_source_messages(self):
        ai.bind(key=lambda: "")
        data = ai._empty_transferania()
        for i in range(101):
            data["messages"].append(
                {"role": "user" if i % 2 == 0 else "assistant", "text": f"t{i}", "ts": float(i), "nsfw": True}
            )
        ai.maybe_compress(data)
        self.assertEqual(len(data["messages"]), 101)
        self.assertFalse(data.get("summary"))

    def test_clear_memory(self):
        ai._record_transferania("user", "test", device_id=DEV)
        code, out = ai.http_post({"action": "transferania", "op": "clear", "device_id": DEV})
        self.assertTrue(out.get("cleared"))
        self.assertEqual(ai.transferania_history(device_id=DEV)["messages"], [])

    def test_device_id_required(self):
        code, out = ai.http_post({"action": "transferania", "op": "history"})
        self.assertEqual(code, 400)
        self.assertEqual(out.get("code"), "device_id")

    def test_status_includes_transferania(self):
        st = ai.status()
        self.assertIn("transferania", st)
        self.assertEqual(st["name"], ai.TRANSFERANIA_NAME)

    def test_reflection_and_expanded_memory_pipeline(self):
        data = ai._empty_transferania()
        ai.merge_thread_facts(
            data,
            "J'adore le café noir le matin. Je travaille sur le moteur Live2D. Je suis super content du rendu !",
            "Moi aussi j'adore te voir avancer dessus, tu veux une pause ?",
        )
        self.assertGreaterEqual(len(data.get("facts") or []), 2)
        self.assertTrue(any("café noir" in f for f in data["facts"]))
        self.assertTrue(any("Live2D" in f for f in data["facts"]))
        self.assertEqual(len(data.get("recent_replies") or []), 1)
        self.assertIn("?", data.get("open_thread") or "")
        ai.save_transferania(data, DEV)

        sig = ai.parse_companion_signals({
            "tension_level": 3,
            "tension_label": "Brûlante & Audacieuse",
            "warmth": 74,
            "fav_acts": "petite fessée coquine, baiser",
            "interactions": ["petite fessée coquine", "souffle chaud sur sa nuque"],
        })
        self.assertEqual(sig["tension_level"], 3)
        self.assertEqual(sig["warmth"], 74)
        self.assertEqual(len(sig["interactions"]), 2)

        sys_prompt = ai.build_transferania_system(
            "chat",
            "flirt",
            nsfw=False,
            view="accueil",
            device_id=DEV,
            signals=sig,
        )
        self.assertIn("RÉFLEXION INTERNE & ÉTAT RELATIONNEL", sys_prompt)
        self.assertIn("petite fessée coquine", sys_prompt)
        self.assertIn("Variété & fraîcheur obligatoire", sys_prompt)
        self.assertIn("café noir", sys_prompt)



class WiringTests(unittest.TestCase):
    def test_bridge(self):
        src = (Path(__file__).resolve().parents[1] / "iphone_bridge.py").read_text(encoding="utf-8")
        self.assertIn('raw == "/api/ai"', src)
        self.assertIn("hq_ai.bind(", src)
        self.assertIn('id="btn-ai"', src)
        self.assertIn("hq-companion.js", src)
        self.assertIn("companion_persona", src)
        ai_py = (Path(__file__).resolve().parents[1] / "hq_ai.py").read_text(encoding="utf-8")
        self.assertIn('a == "transferania"', ai_py)
        self.assertIn("transferania_prefs.json", ai_py)
        self.assertIn("TRANSFERANIA_THREADS", ai_py)
        self.assertNotIn("AQ.", src, "no API key in the code")


class SearchGroundingTests(Base):
    def test_search_sends_the_tool_skips_gemma_and_reports_sources(self):
        status, data = reply("fact")
        data["candidates"][0]["groundingMetadata"] = {
            "webSearchQueries": ["song sample"],
            "groundingChunks": [{"web": {"uri": "https://vertexaisearch.example/1", "title": "wikipedia.org"}},
                                {"web": {"uri": "http://insecure.example", "title": "x"}}]}
        self.answers = [(400, {"error": {"message": "tool not supported"}}), (status, data)]
        grounding = {}
        text, model = ai.generate(("gemini-3.1-flash-lite", "gemma-4-31b-it", "gemini-3.5-flash-lite"), "sys",
                                  [{"role": "user", "parts": [{"text": "q"}]}], search=True, grounding=grounding)
        self.assertEqual((text, model), ("fact", "gemini-3.5-flash-lite"))  # 400 on the first: next model, gemma skipped
        self.assertNotIn("gemma-4-31b-it", [c[0] for c in self.calls])
        self.assertEqual(self.calls[0][1]["tools"], [{"google_search": {}}])
        self.assertEqual(grounding, {"queries": ["song sample"],
                                     "sources": [{"title": "wikipedia.org", "uri": "https://vertexaisearch.example/1"}]})

    def test_search_refusal_pauses_search_only(self):
        self.answers = [(429, {"error": {"message": "quota"}})]
        with self.assertRaises(ai.AiError):
            ai.generate(("gemini-3.1-flash-lite",), "sys", [{"role": "user", "parts": [{"text": "q"}]}], search=True)
        holds = ai.usage().get("model_backoff_until", {})
        self.assertIn("gemini-3.1-flash-lite#search", holds)
        self.assertNotIn("gemini-3.1-flash-lite", holds)  # normal use of the model is untouched
        self.calls.clear()
        with self.assertRaises(ai.AiError):  # within the pause: no request is sent at all
            ai.generate(("gemini-3.1-flash-lite",), "sys", [{"role": "user", "parts": [{"text": "q"}]}], search=True)
        self.assertEqual(self.calls, [])
        text, _model = ai.generate(("gemini-3.1-flash-lite",), "sys", [{"role": "user", "parts": [{"text": "q"}]}])
        self.assertEqual(text, "ok")


class HealthOrderTests(Base):
    chain = ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it")

    def test_failing_model_goes_last_and_recovers(self):
        for _ in range(4):
            ai._health_note("gemini-3.1-flash-lite", False)
        self.assertEqual(ai._health_order(self.chain), ("gemini-3.5-flash-lite", "gemma-4-31b-it", "gemini-3.1-flash-lite"))
        self.assertTrue(ai.model_health("gemini-3.1-flash-lite")["demoted"])
        for _ in range(8):
            ai._health_note("gemini-3.1-flash-lite", True)
        self.assertEqual(ai._health_order(self.chain), self.chain)  # 4 failures in 12 calls is under the threshold

    def test_too_few_samples_keep_the_authored_order(self):
        for _ in range(3):
            ai._health_note("gemini-3.1-flash-lite", False)
        self.assertEqual(ai._health_order(self.chain), self.chain)

    def test_generate_skips_to_the_healthy_model(self):
        for _ in range(4):
            ai._health_note("gemini-3.1-flash-lite", False)
        text, model = ai.generate(self.chain, "sys", [{"role": "user", "parts": [{"text": "q"}]}])
        self.assertEqual((text, model), ("ok", "gemini-3.5-flash-lite"))

    def test_deep_chain_has_the_extra_pools_and_a_missing_model_is_skipped(self):
        for m in ("gemini-3.8-flash", "gemini-4-hydrogen", "gemini-3-flash-preview"):
            self.assertIn(m, ai.DEEP_CHAIN)
            self.assertIn(m, ai.MODELS)
        self.answers = [(404, {"error": {"message": "models/x is not found"}})]
        text, model = ai.generate(ai.DEEP_CHAIN, "sys", [{"role": "user", "parts": [{"text": "q"}]}])
        self.assertEqual(model, "gemini-4-hydrogen")  # the first model 404ed, the chain went on
        self.assertIn("gemini-3.6-flash", ai.usage().get("model_backoff_until", {}))

    def test_overload_is_recorded_but_quota_429_is_not(self):
        self.answers = [(429, {"error": {"message": "quota"}})] * 2
        with self.assertRaises(ai.AiError):
            ai.generate(("gemini-3.1-flash-lite",), "sys", [{"role": "user", "parts": [{"text": "q"}]}])
        self.assertEqual(ai.model_health("gemini-3.1-flash-lite")["samples"], 0)
        self.answers = [(503, {"error": {"message": "high demand"}})]
        with self.assertRaises(ai.AiError):
            ai.generate(("gemini-3.5-flash-lite",), "sys", [{"role": "user", "parts": [{"text": "q"}]}])
        self.assertEqual(ai.model_health("gemini-3.5-flash-lite"), {"samples": 1, "failures": 1, "demoted": False})


class LocalLlmTests(Base):
    """The small LLM on the voice-worker PC: a fallback and a low-quota relief, never for the rest."""
    Q = [{"role": "user", "parts": [{"text": "q"}]}]
    DOWN = (503, {"error": {"message": "high demand"}})

    def setUp(self):
        super().setUp()
        self.asked = []
        self.reply = "Bonsoir, Maître."

        def local(messages, temperature, max_tokens, timeout, json_mode=False):
            self.asked.append((messages, temperature, max_tokens, timeout, json_mode))
            return self.reply

        ai.bind(local_llm=lambda: True, local_llm_call=local)

    def spend(self, fraction, chain=ai.AMBIENT_CHAIN):
        with ai._usage_transaction():
            u = ai.usage()
            for model in chain:
                u["count"][model] = int(ai.MODELS[model][2] * fraction)
            ai._save_usage(u)

    def test_with_quota_left_gemini_answers_and_the_laptop_is_not_asked(self):
        self.answers = [reply("depuis Gemini")]
        text, model = ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)
        self.assertEqual(text, "depuis Gemini")
        self.assertNotEqual(model, ai.LOCAL_MODEL)
        self.assertEqual(self.asked, [])

    def test_when_every_gemini_model_failed_the_laptop_answers(self):
        self.answers = [self.DOWN] * 12
        text, model = ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)
        self.assertEqual((text, model), ("Bonsoir, Maître.", ai.LOCAL_MODEL))
        self.assertTrue(self.calls)  # Gemini was tried first
        self.assertEqual([m["role"] for m in self.asked[0][0]], ["system", "user"])
        self.assertEqual(self.asked[0][2], 256)

    def test_background_text_too(self):
        self.answers = [self.DOWN] * 12
        self.assertEqual(ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, background=True)[1], ai.LOCAL_MODEL)

    def test_when_google_is_nearly_out_the_laptop_goes_first_and_gemini_is_spared(self):
        self.spend(0.95)  # 5 % left on every model of the chain, key 1 (the only key)
        text, model = ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)
        self.assertEqual(model, ai.LOCAL_MODEL)
        self.assertEqual(self.calls, [])
        self.assertEqual(ai.ambient_used(), 0)

    def test_one_model_with_room_left_keeps_gemini_first(self):
        self.spend(0.95, chain=("gemini-3.1-flash-lite", "gemma-4-26b-a4b-it"))  # gemini-3.5-flash-lite is still fresh
        self.answers = [reply("depuis Gemini")]
        self.assertNotEqual(ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)[1], ai.LOCAL_MODEL)
        self.assertEqual(self.asked, [])

    def test_a_spent_ambient_budget_is_answered_by_the_laptop_instead_of_an_error(self):
        with ai._usage_transaction():
            u = ai.usage()
            u["ambient"] = ai.daily_limit("ambient")
            ai._save_usage(u)
        self.assertEqual(ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)[1], ai.LOCAL_MODEL)
        self.assertEqual(self.calls, [])

    def test_an_unavailable_laptop_changes_nothing(self):
        self.reply = ""  # offline, busy with voice, breaker open, too slow
        self.answers = [self.DOWN] * 12
        with self.assertRaises(ai.AiError):
            ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)
        self.spend(0.95)
        self.answers = [reply("depuis Gemini")]
        self.assertNotEqual(ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)[1], ai.LOCAL_MODEL)

        def boom(*a):
            raise OSError("down")
        ai.bind(local_llm_call=boom)
        self.answers = [reply("depuis Gemini")]
        self.assertNotEqual(ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)[1], ai.LOCAL_MODEL)

    def test_never_for_chat_adult_json_search_images_visits_or_big_prompts(self):
        self.spend(1.0)  # worst case for the exclusions: Google is out and every call fails
        self.answers = [self.DOWN] * 60
        image = [{"role": "user", "parts": [{"text": "q"}, {"inlineData": {"mimeType": "image/png", "data": "AAAA"}}]}]
        cases = [(("sys", self.Q), {}), (("sys", self.Q), {"nsfw": True, "ambient": True}), (("sys", self.Q), {"ambient": True, "json_out": True}),
                 (("sys", self.Q), {"ambient": True, "search": True}), (("sys", self.Q), {"background": True, "json_out": True}),
                 (("sys", self.Q), {"ambient": True, "transferania": True}), (("sys", image), {"ambient": True}),
                 (("x" * 40000, self.Q), {"background": True}), (("sys", self.Q), {"ambient": True, "on_delta": lambda piece: None})]
        for args, kwargs in cases:
            try:
                ai.generate(ai.AMBIENT_CHAIN, *args, **kwargs)
            except ai.AiError:
                pass  # only whether the laptop was asked matters
        self.assertEqual(self.asked, [])

    def test_a_chip_visit_may_use_the_laptop_with_json_mode_when_gemini_failed(self):
        self.reply = '{"lines": ["a", "b"]}'
        self.answers = [self.DOWN] * 4
        text, model = ai.generate(("gemini-3.1-flash-lite",), "sys", self.Q, json_out=True, visit=True, max_tokens=360)
        self.assertEqual((text, model), ('{"lines": ["a", "b"]}', ai.LOCAL_MODEL))
        self.assertTrue(self.asked[0][4])  # json_mode reached the worker
        self.assertIn("JSON", self.asked[0][0][0]["content"])

    def test_a_reply_that_is_not_json_is_refused_and_the_error_stands(self):
        self.reply = "Bonjour !"
        self.answers = [self.DOWN] * 4
        with self.assertRaises(ai.AiError):
            ai.generate(("gemini-3.1-flash-lite",), "sys", self.Q, json_out=True, visit=True)
        self.reply = "```json\n{\"a\": 1}\n```"
        self.answers = [self.DOWN] * 4
        self.assertEqual(json.loads(ai.generate(("gemini-3.1-flash-lite",), "sys", self.Q, json_out=True, visit=True)[0]), {"a": 1})

    def test_a_spent_visit_budget_goes_to_the_laptop(self):
        self.reply = '{"ok": true}'
        with ai._usage_transaction():
            u = ai.usage()
            u["visits"] = ai.daily_limit("visit")
            ai._save_usage(u)
        self.assertEqual(ai.generate(("gemini-3.1-flash-lite",), "sys", self.Q, json_out=True, visit=True)[1], ai.LOCAL_MODEL)
        self.assertEqual(self.calls, [])

    def test_off_by_default(self):
        ai.bind(local_llm=lambda: False)
        self.spend(1.0)
        self.answers = [self.DOWN] * 12
        with self.assertRaises(ai.AiError):
            ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)
        self.assertEqual(self.asked, [])


class NimFallbackTests(Base):
    Q = [{"role": "user", "parts": [{"text": "q"}]}]

    def setUp(self):
        super().setUp()
        self.nim_calls = []
        self.nim_reply = (200, {"choices": [{"message": {"content": "réponse nim"}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 20}})

        def post(url, body, headers, timeout):
            if "integrate.api.nvidia.com" in url:
                self.nim_calls.append((body, headers))
                return self.nim_reply
            self.calls.append(url)
            return 503, {"error": {"message": "high demand"}}

        ai.bind(post=post, nvidia_key=lambda: "nvapi-test", nim_fallback=lambda: True)

    def test_deep_call_overflows_to_mistral_with_low_reasoning(self):
        history = [{"role": "user", "parts": [{"text": "a"}]}, {"role": "model", "parts": [{"text": "b"}]}, {"role": "user", "parts": [{"text": "c"}]}]
        text, model = ai.generate(ai.DEEP_CHAIN, "sys", history)
        self.assertEqual((text, model), ("réponse nim", ai.NIM_DEEP_MODEL))
        body, headers = self.nim_calls[0]
        self.assertEqual(body["reasoning_effort"], "low")
        self.assertEqual([m["role"] for m in body["messages"]], ["system", "user", "assistant", "user"])
        self.assertEqual(headers["Authorization"], "Bearer nvapi-test")
        self.assertEqual(ai.usage()["count"][ai.NIM_DEEP_MODEL], 1)

    def test_background_call_uses_bolt_with_thinking_off_and_counts_ambient(self):
        text, model = ai.generate(ai.AMBIENT_CHAIN, "sys", self.Q, ambient=True)
        self.assertEqual(model, ai.NIM_QUICK_MODEL)
        self.assertEqual(self.nim_calls[0][0]["chat_template_kwargs"], {"thinking": False})
        self.assertEqual(ai.usage()["count"][ai.NIM_QUICK_MODEL], 1)
        self.assertEqual(ai.ambient_used(), len(self.calls) + 1)  # each Gemini attempt and the NIM call count against the ambient budget

    def test_json_fences_are_stripped(self):
        self.nim_reply = (200, {"choices": [{"message": {"content": "```json\n{\"a\": 1}\n```"}, "finish_reason": "stop"}]})
        text, _model = ai.generate(ai.DEEP_CHAIN, "sys", self.Q, json_out=True)
        self.assertEqual(json.loads(text), {"a": 1})

    def test_never_used_when_off_or_for_adult_search_images_or_plain_chat(self):
        with self.assertRaises(ai.AiError):
            ai.generate(ai.ASK_CHAIN, "sys", self.Q)  # a plain ask is not eligible
        with self.assertRaises(ai.AiError):
            ai.generate(ai.DEEP_CHAIN, "sys", self.Q, nsfw=True)
        with self.assertRaises(ai.AiError):
            ai.generate(ai.SEARCH_CHAIN, "sys", self.Q, search=True)
        with self.assertRaises(ai.AiError):
            ai.generate(ai.DEEP_CHAIN, "sys", [{"role": "user", "parts": [{"text": "q"}, {"inlineData": {"mimeType": "image/png", "data": "AAAA"}}]}])
        ai.bind(nim_fallback=lambda: False)
        with self.assertRaises(ai.AiError):
            ai.generate(ai.DEEP_CHAIN, "sys", self.Q)
        self.assertEqual(self.nim_calls, [])

    def test_a_failing_nim_reply_reports_the_gemini_failure(self):
        self.nim_reply = (503, {})
        with self.assertRaises(ai.AiError) as ctx:
            ai.generate(ai.DEEP_CHAIN, "sys", self.Q)
        self.assertEqual(ctx.exception.code, "busy")
        self.assertEqual(ai.model_health(ai.NIM_DEEP_MODEL)["failures"], 1)


class ReplyLanguageTests(unittest.TestCase):
    def setUp(self):  # the per-request mechanism; the English-only policy has its own tests
        import os
        from unittest import mock
        patcher = mock.patch.dict(os.environ, {"HQ_ENGLISH_ONLY": "0"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_english_pinned_characters_get_the_directive_in_every_prompt_builder(self):
        from unittest import mock
        with mock.patch("hq_voice_phonon.language_directive", side_effect=lambda c: f"LANGUAGE OVERRIDE for {c}"):
            for who in ("else", "transferania"):
                self.assertIn(f"LANGUAGE OVERRIDE for {who}", ai.build_sister_system(who, nsfw=False, view="accueil", device_id="d" * 12))
            self.assertIn("LANGUAGE OVERRIDE for else", ai.build_else_system("chat", "warm", nsfw=False, view="accueil", device_id="d" * 12))
            self.assertIn("LANGUAGE OVERRIDE for else", ai.build_else_system("chat", "warm", nsfw=False, view="accueil", device_id="d" * 12, context_core=True))
        with mock.patch("hq_voice_phonon.language_directive", return_value=""):
            self.assertNotIn("LANGUAGE OVERRIDE", ai.build_sister_system("else", nsfw=False, view="accueil", device_id="d" * 12))

    def test_speech_language_follows_the_reply_language(self):
        from unittest import mock
        with mock.patch("hq_voice_phonon.reply_language", side_effect=lambda c: "en" if c == "else" else None):
            self.assertEqual((ai.speech_language("else"), ai.speech_language("transferania")), ("en", "fr"))


if __name__ == "__main__":
    unittest.main()
