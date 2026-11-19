"""Authenticated HQ HTTP and browser flow on a temporary simulation bridge."""

import atexit
from contextlib import contextmanager, nullcontext
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import hq_robotics
import hq_robotics_assistant as assistant
import hq_robotics_camera
import iphone_bridge as bridge
from tests import hq_temp_janitor
from tests.test_hq_diagnostics_http import Client

ADMIN, UPLOAD = "58390241", "97415682"


def _mark_leftover_roots() -> None:
    """At process exit, make any root recreated by a daemon write sweepable."""
    try:
        for path in Path(tempfile.gettempdir()).glob("hq-robotics-http-*"):
            if path.is_dir() and not path.is_symlink():
                hq_temp_janitor.mark(path)
    except OSError:
        pass


atexit.register(_mark_leftover_roots)


@contextmanager
def _fixture_root():
    # This fixture creates HQ stores but no assets copy. Tag the root before use,
    # and re-tag a partial root left by a locked telemetry file so the janitor
    # can still recognise and sweep an interrupted run.
    root = Path(tempfile.mkdtemp(prefix="hq-robotics-http-"))
    hq_temp_janitor.mark(root)
    try:
        yield root
    finally:
        # A background visit/telemetry write can hold a file for a fraction of
        # a second on Windows; retry briefly before handing a leftover to the
        # janitor, and keep it recognisable if it still survives.
        for _ in range(6):
            hq_temp_janitor.safe_rmtree(root)
            if not root.exists():
                break
            time.sleep(.05)
        if root.exists():
            hq_temp_janitor.mark(root)


@contextmanager
def fixture():
    with _fixture_root() as root:
        for name in ("Inbox", "Uni", "Print"):
            (root / name).mkdir()
        cfg = {**bridge.CONFIG, "pin": "", "users": [
            {"id": "rb_admin", "name": "Robotics test", "pin": ADMIN, "role": "admin"},
            {"id": "rb_upload", "name": "Uploader test", "pin": UPLOAD, "role": "upload"},
        ], "push_enabled": False, "discord_webhook_url": "", "public_base_urls": [],
            "client_debug_hud": False, "client_debug_agent": False,
            "backup_dir": str(root / "backups"), "emergency_lockdown": False}
        diag = {"root": None, "assets": None, "last_probe": None}

        class Quiet(bridge.Handler):
            def log_message(self, *_):
                pass

        with (patch.dict(os.environ, {"HQ_CLIENT_DEBUG": "0"}),
              patch.multiple(bridge, ROOT=root, CONFIG=cfg, SESSIONS_PATH=root / "sessions.json",
                             CONFIG_PATH=root / "bridge_config.json", TMP_DIR=root / ".tmp",
                             _SESSIONS={}, _DIAG_STATE=diag, _HQ_BOUND=False),
              patch.object(bridge, "tailscale_ipv4", return_value=None),
              patch.object(bridge, "tailscale_dns_name", return_value=""),
              ThreadingHTTPServer(("127.0.0.1", 0), Quiet) as server):
            bridge.bind_cc_ext()
            bridge.bind_hq()
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            try:
                lab = hq_robotics.controller(root)
                yield f"http://127.0.0.1:{server.server_address[1]}", lab
            finally:
                lab.camera.close()
                server.shutdown()
                worker.join()
                hq_robotics._instances.pop(root, None)


def post(client, path, body=None, **kw):
    return client.j("/api/robotics/" + path, "POST", data=json.dumps(body or {}).encode(),
                    headers={"Content-Type": "application/json", **kw.pop("headers", {})}, **kw)


class Access(unittest.TestCase):
    def test_camera_audio_requires_local_admin_csrf_and_stream_owner(self):
        offer = ("v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 8\r\na=recvonly\r\n"
                 "a=candidate:1 1 udp 100 192.168.2.7 40000 typ host\r\n")
        with fixture() as (base, lab), patch.object(lab.camera, "audio_answer", return_value="v=0\r\n") as answer:
            admin, other = Client(base, ADMIN), Client(base, ADMIN)
            upload = Client(base, UPLOAD)
            lab.video = hq_robotics.Stream(admin.token, "stream", "standard", time.monotonic() + 10, opened=True)
            request = {"stream": "stream", "mode": "listen", "offer": offer}
            self.assertEqual(post(upload, "camera/audio", request)[0], 403)
            self.assertEqual(post(other, "camera/audio", request)[0], 403)
            self.assertEqual(post(admin, "camera/audio", request, origin=False)[0], 403)
            self.assertEqual(post(admin, "camera/audio", request, headers={"X-Forwarded-For": "192.168.2.7"})[0], 403)
            self.assertEqual(post(admin, "camera/audio", {**request, "mode": "talk"})[0], 409)
            answer.assert_not_called()
            self.assertEqual(post(admin, "camera/audio", request), (200, {"ok": True, "answer": "v=0\r\n"}))
            answer.assert_called_once_with("stream", offer, False)
        self.assertNotIn("candidate", hq_robotics_camera.local_audio_offer(offer, False))
        with self.assertRaises(ValueError):
            hq_robotics_camera.local_audio_offer(offer, True)
        with self.assertRaises(ValueError):
            hq_robotics_camera.local_audio_offer(offer + "m=video 9 UDP/TLS/RTP/SAVPF 96\r\n", False)

    def test_assistant_requires_both_approvals_and_matches_the_stored_steps(self):
        draft = {"reply": "Voici un pas.", "script": {"title": "Petit écart", "steps": [
            {"base": 2, "shoulder": 0, "elbow": 90, "hand": 180},
        ]}}
        review = {"verdict": "pass", "notes": "Le pas demandé correspond au script."}
        with fixture() as (base, lab), patch.object(assistant.hq_ai, "generate", side_effect=[
            (json.dumps(draft), assistant.DRAFT_MODELS[0]),
            (json.dumps(review), assistant.REVIEW_MODELS[0]),
        ]) as generate:
            admin = Client(base, ADMIN)
            upload = Client(base, UPLOAD)
            self.assertEqual(post(upload, "assistant/message", {"text": "Bouge"})[0], 403)
            self.assertEqual(post(admin, "assistant/message", {"text": "Bouge"}, origin=False)[0], 403)
            code, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            self.assertEqual(code, 200, thread)
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 403)
            code, lease = post(admin, "arm")
            self.assertEqual(code, 200)
            code, status = admin.j("/api/robotics/status", headers={"X-HQ-Robotics-Lease": lease["lease"]})
            move = {**version, "kind": "reviewed_script", "index": 0, "lease": lease["lease"], "ticket": status["ticket"]}
            self.assertEqual(post(admin, "move", move)[0], 403)
            self.assertEqual(post(admin, "assistant/review", version)[0], 200)
            self.assertEqual(generate.call_args_list[0].args[0], assistant.DRAFT_MODELS)
            self.assertEqual(generate.call_args_list[1].args[0], assistant.REVIEW_MODELS)
            self.assertEqual(post(admin, "move", move)[0], 403)
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 200)
            self.assertEqual(post(admin, "move", {**move, "digest": "changed"})[0], 404)
            code, moved = post(admin, "move", {**move, "pose": {"base": 80}})
            self.assertEqual(code, 200, moved)
            self.assertEqual(moved["target"]["base"], 2)
            other = assistant.store_path(lab, "another-admin")
            self.assertEqual(assistant.load(other)["scripts"], {})
            with self.assertRaises(hq_robotics.Rejected):
                assistant.resolve_step(lab, {**lab.config(), "mode": "hardware"}, "rb_admin", move)

    DRAFT = {"reply": "Voici un pas.", "script": {"title": "Petit écart", "summary": "Tourne la base de 2°.", "steps": [
        {"base": 2, "shoulder": 0, "elbow": 90, "hand": 180}]}}
    REVIEW = {"verdict": "pass", "notes": "Le pas demandé correspond au script."}

    def generate(self):
        return patch.object(assistant.hq_ai, "generate", side_effect=[
            (json.dumps(self.DRAFT), assistant.DRAFT_MODELS[0]),
            (json.dumps(self.REVIEW), assistant.REVIEW_MODELS[0]),
        ])

    def test_library_save_rename_rebase_delete_and_isolation(self):
        with fixture() as (base, lab), self.generate():
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            self.assertFalse(script["saved"])
            self.assertEqual(len(script["trace"]), 2)
            self.assertEqual(len(script["trace"][0]), 3)
            self.assertEqual(len(script["timeline"]), 1)
            self.assertGreaterEqual(script["timeline"][0], .25)
            self.assertEqual(script["summary"], "Tourne la base de 2°.")
            self.assertIn("Base 0° → 2°", script["summary_auto"])
            self.assertTrue(script["summary_auto"].startswith("1 étape ·"))
            self.assertTrue(post(admin, "assistant/library/save", version)[1]["scripts"][key]["saved"])
            _, renamed = post(admin, "assistant/library/rename", {**version, "label": "Mon geste"})
            self.assertEqual(renamed["scripts"][key]["label"], "Mon geste")
            self.assertEqual(renamed["scripts"][key]["digest"], script["digest"])
            self.assertEqual(post(admin, "assistant/library/rename", {**version, "label": "  "})[0], 400)
            self.assertEqual(post(admin, "assistant/review", version)[0], 200)
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 200)
            self.assertEqual(post(admin, "assistant/library/remove", version)[1]["scripts"][key]["saved"], False)
            self.assertTrue(post(admin, "assistant/library/save", version)[1]["scripts"][key]["saved"])
            self.assertEqual(post(admin, "assistant/library/rebase", version)[0], 409)
            self.assertEqual(post(admin, "settings", {"speed": 90})[0], 200)
            code, rebased = post(admin, "assistant/library/rebase", version)
            self.assertEqual(code, 200, rebased)
            self.assertNotIn(key, rebased["scripts"])
            new_key, new = next(iter(rebased["scripts"].items()))
            self.assertTrue(new["saved"])
            self.assertEqual(new["label"], "Mon geste")
            self.assertEqual(new["summary"], "Tourne la base de 2°.")
            self.assertIsNone(new["review"])
            self.assertIsNone(new["approval"])
            self.assertEqual(new["speed"], 90)
            self.assertNotEqual(new["digest"], script["digest"])
            self.assertEqual(rebased["messages"][-1]["script_id"], new_key)
            fresh = {"id": new_key, "digest": new["digest"]}
            self.assertEqual(post(admin, "assistant/approve", {**fresh, "confirmed": True})[0], 403)
            with self.assertRaises(hq_robotics.Rejected):
                assistant.dispatch(lab, "library/delete", "POST", fresh, "another-admin", lambda: True)
            self.assertEqual(post(admin, "assistant/library/delete", fresh)[1]["scripts"], {})

    def test_edit_creates_a_new_unreviewed_version_and_validates_the_steps(self):
        with fixture() as (base, lab), self.generate():
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            self.assertEqual(post(admin, "assistant/review", version)[0], 200)
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 200)
            edit = {"title": "Plus grand", "steps": [{"base": 10, "shoulder": 0, "elbow": 90, "hand": 180}]}
            for bad in ({**edit, "start": {}}, {"title": "x"}, {**edit, "steps": []},
                        {**edit, "steps": [{"base": 99, "shoulder": 0, "elbow": 90, "hand": 180}]},
                        {**edit, "steps": [{"base": True, "shoulder": 0, "elbow": 90, "hand": 180}]},
                        {**edit, "speed": 500}, "text"):
                with self.subTest(bad=bad):
                    self.assertEqual(post(admin, "assistant/library/edit", {**version, "script": bad})[0], 400)
            self.assertEqual(post(admin, "assistant/library/edit", {**version, "script": {
                "title": script["title"], "summary": script["summary"], "steps": script["steps"]}})[0], 409)
            code, edited = post(admin, "assistant/library/edit", {**version, "script": edit})
            self.assertEqual(code, 200, edited)
            fresh_key, fresh = next((k, s) for k, s in edited["scripts"].items() if k != key)
            self.assertEqual(fresh["title"], "Plus grand")
            self.assertEqual(fresh["steps"][0]["base"], 10)
            self.assertTrue(fresh["edited"])
            self.assertTrue(fresh["saved"])
            self.assertIsNone(fresh["review"])
            self.assertIsNone(fresh["approval"])
            self.assertFalse(edited["scripts"][key]["saved"])
            moved = {"id": fresh_key, "digest": fresh["digest"], "kind": "reviewed_script", "index": 0}
            self.assertEqual(post(admin, "assistant/approve", {"id": fresh_key, "digest": fresh["digest"],
                                                                "confirmed": True})[0], 403)
            self.assertEqual(moved["kind"], "reviewed_script")

    def test_rebase_refuses_a_script_outside_the_new_limits(self):
        with fixture() as (base, lab), self.generate():
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            limits = {**lab.config()["joint_limits"], "base": [-1, 1]}
            self.assertEqual(post(admin, "settings", {"joint_limits": limits})[0], 200)
            self.assertEqual(post(admin, "assistant/library/rebase", version)[0], 400)
            self.assertIn(key, assistant.load(assistant.store_path(lab, "rb_admin"))["scripts"])

    def test_last_step_records_the_play(self):
        with fixture() as (base, lab), self.generate():
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            post(admin, "assistant/review", version)
            post(admin, "assistant/approve", {**version, "confirmed": True})
            _, lease = post(admin, "arm")
            _, status = admin.j("/api/robotics/status", headers={"X-HQ-Robotics-Lease": lease["lease"]})
            move = {**version, "kind": "reviewed_script", "index": 0, "lease": lease["lease"], "ticket": status["ticket"]}
            self.assertEqual(post(admin, "move", move)[0], 200)
            _, thread = admin.j("/api/robotics/assistant/thread")
            self.assertEqual(thread["scripts"][key]["play_count"], 1)
            self.assertIsNotNone(thread["scripts"][key]["last_played_at"])
            self.assertTrue(thread["scripts"][key]["saved"])  # approval keeps the script in the library

    def test_unsaved_drafts_are_capped_but_saved_scripts_survive(self):
        state = {"messages": [], "scripts": {"keep": {"saved": True},
                                             **{f"d{i}": {"saved": False} for i in range(assistant.MAX_SCRIPTS + 3)}}}
        assistant.prune(state)
        self.assertIn("keep", state["scripts"])
        self.assertEqual(sum(1 for item in state["scripts"].values() if not item["saved"]), assistant.MAX_SCRIPTS)
        self.assertNotIn("d0", state["scripts"])
        self.assertIn("d3", state["scripts"])

    def test_reviewer_gets_computed_xyz_and_a_revise_verdict_can_be_asked_again(self):
        revise = {"verdict": "revise", "notes": "Les angles semblent réduire la portée."}
        with fixture() as (base, lab), patch.object(assistant.hq_ai, "generate", side_effect=[
            (json.dumps(self.DRAFT), assistant.DRAFT_MODELS[0]),
            (json.dumps(revise), assistant.REVIEW_MODELS[0]),
            (json.dumps(self.REVIEW), assistant.REVIEW_MODELS[0]),
        ]) as generate:
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            _, first = post(admin, "assistant/review", version)
            self.assertEqual(first["scripts"][key]["review"]["verdict"], "revise")
            payload = json.loads(generate.call_args_list[1].args[2][0]["parts"][0]["text"])
            self.assertEqual(len(payload["steps_xyz_mm"]), 1)
            self.assertEqual(set(payload["start_xyz_mm"]), {"x", "y", "z"})
            # Without `again`, a stored verdict is kept and the model is not called again.
            post(admin, "assistant/review", version)
            self.assertEqual(generate.call_count, 2)
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 403)
            code, second = post(admin, "assistant/review", {**version, "again": True})
            self.assertEqual(code, 200, second)
            self.assertEqual(second["scripts"][key]["review"]["verdict"], "pass")
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 200)

    def test_manual_approval_works_without_the_model_and_is_recorded_as_manual(self):
        with fixture() as (base, lab), patch.object(assistant.hq_ai, "generate", side_effect=[
            (json.dumps(self.DRAFT), assistant.DRAFT_MODELS[0]),
            assistant.hq_ai.AiError("Aucune clé : ajoute gemini_api_key", 503, "no_key"),
        ]):
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Tourne la base de deux degrés."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            code, refused = post(admin, "assistant/review", version)
            self.assertEqual(code, 503)
            self.assertIn("no_key", refused["error"])  # the reason is visible, not just "unavailable"
            self.assertNotIn("gemini_api_key=", refused["error"])
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 403)
            self.assertEqual(post(admin, "assistant/approve", {**version, "manual": True})[0], 403)  # needs confirmed
            code, done = post(admin, "assistant/approve", {**version, "confirmed": True, "manual": True})
            self.assertEqual(code, 200, done)
            approval = done["scripts"][key]["approval"]
            self.assertTrue(approval["manual"])
            self.assertIsNone(done["scripts"][key]["review"])  # never recorded as a model pass
            _, lease = post(admin, "arm")
            _, status = admin.j("/api/robotics/status", headers={"X-HQ-Robotics-Lease": lease["lease"]})
            move = {**version, "kind": "reviewed_script", "index": 0, "lease": lease["lease"], "ticket": status["ticket"]}
            # A changed script voids the manual approval like any other.
            self.assertEqual(post(admin, "move", {**move, "digest": "changed"})[0], 404)
            self.assertEqual(post(admin, "move", move)[0], 200)

    def test_review_failure_leaves_the_script_locked(self):
        proposal = {"reply": "Voici un pas.", "script": {"title": "Petit écart", "steps": [
            {"base": 2, "shoulder": 0, "elbow": 90, "hand": 180},
        ]}}
        with fixture() as (base, _), patch.object(assistant.hq_ai, "generate", side_effect=[
            (json.dumps(proposal), assistant.DRAFT_MODELS[0]),
            assistant.hq_ai.AiError("network", 503),
            (json.dumps({"verdict": "revise", "notes": "Demande ambiguë."}), assistant.REVIEW_MODELS[0]),
        ]):
            admin = Client(base, ADMIN)
            _, thread = post(admin, "assistant/message", {"text": "Fais un petit mouvement."})
            key, script = next(iter(thread["scripts"].items()))
            version = {"id": key, "digest": script["digest"]}
            self.assertEqual(post(admin, "assistant/review", version)[0], 503)
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 403)
            self.assertEqual(post(admin, "assistant/review", version)[0], 200)
            self.assertEqual(post(admin, "assistant/approve", {**version, "confirmed": True})[0], 403)

    def test_hq_auth_csrf_and_proxy(self):
        with fixture() as (base, _lab):
            anon, upload, admin = Client(base, None), Client(base, UPLOAD), Client(base, ADMIN)
            self.assertEqual(post(anon, "arm")[0], 401)
            self.assertEqual(post(upload, "arm")[0], 403)
            self.assertEqual(upload.j("/api/robotics/status")[0], 403)
            self.assertEqual(post(admin, "arm", origin=False)[0], 403)
            self.assertEqual(post(admin, "arm", headers={"Origin": "https://untrusted.invalid"})[0], 403)
            self.assertEqual(post(admin, "settings", {"mode": "hardware"},
                                  headers={"X-Forwarded-For": "127.0.0.1"})[0], 403)
            status, initial = admin.j("/api/robotics/status")
            self.assertEqual(status, 200)
            self.assertTrue(initial["physical_local"])
            self.assertFalse(initial["armed"])
            self.assertEqual(post(admin, "move", {"kind": "home"})[0], 403)
            status, lease = post(admin, "arm")
            self.assertEqual(status, 200)
            _status, state = admin.j("/api/robotics/status", headers={"X-HQ-Robotics-Lease": lease["lease"]})
            self.assertTrue(state["ticket"])
            self.assertEqual(post(admin, "move", {**lease, "ticket": state["ticket"], "kind": "home"})[0], 200)
            self.assertEqual(post(admin, "move", {**lease, "ticket": state["ticket"], "kind": "home"})[0], 409)
            self.assertTrue(post(admin, "stop")[1]["stop_latched"])


@unittest.skipUnless(os.environ.get("HQ_ROBOTICS_BROWSER") == "1", "Set HQ_ROBOTICS_BROWSER=1 for Chromium")
class Browser(unittest.TestCase):
    def test_assistant_chip_and_reviewed_playback(self):
        from playwright.sync_api import expect, sync_playwright

        draft = {"reply": "J’ai préparé deux pas.", "script": {"title": "Aller-retour", "steps": [
            {"base": 2, "shoulder": 0, "elbow": 90, "hand": 180},
            {"base": 0, "shoulder": 0, "elbow": 90, "hand": 180},
        ]}}
        review = {"verdict": "pass", "notes": "Les deux étapes correspondent à la demande."}

        def model_reply(chain, system, *_args, **_kwargs):
            """Answer by prompt rather than by call order: opening the chip checks in first."""
            if system == assistant.CHECKIN_PROMPT:
                return (json.dumps({"reply": "Banc prêt, Maître.", "mood": "focused"}), assistant.DRAFT_MODELS[0])
            if system == assistant.DRAFT_PROMPT:
                return (json.dumps(draft), assistant.DRAFT_MODELS[0])
            return (json.dumps(review), assistant.REVIEW_MODELS[0])

        with (fixture() as (base, _), sync_playwright() as p,
              patch.object(assistant.hq_ai, "generate", side_effect=model_reply)):
            browser = p.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            admin = Client(base, ADMIN)
            page.context.add_cookies([{"name": bridge.COOKIE_NAME, "value": admin.token, "url": base}])
            page.on("dialog", lambda dialog: dialog.accept())
            page.goto(base + "/#robotique", wait_until="domcontentloaded")
            chip = page.get_by_role("button", name="Ouvrir Kinétia", exact=True)
            expect(chip).to_be_visible(timeout=15000)
            before = chip.bounding_box()
            page.mouse.move(before["x"] + 25, before["y"] + 25)
            page.mouse.down()
            page.mouse.move(before["x"] - 70, before["y"] - 20, steps=5)
            page.mouse.up()
            self.assertLess(chip.bounding_box()["x"], before["x"])
            chat = page.get_by_role("dialog", name="Kinétia")
            expect(chat).to_be_hidden()
            chip.click()
            expect(chat).to_be_visible()
            # The suggestion row overflows the 430 px desktop card too: same edge fade, not a hard cut.
            # It is filled by the opening check-in, so wait for the row instead of sampling it blind.
            page.wait_for_function("""() => {
                const row = document.querySelector('#hq-robotics-chat .rb-ai-chips');
                return row && row.scrollWidth > row.clientWidth + 2 && row.classList.contains('is-overflow') &&
                    getComputedStyle(row).maskImage !== 'none';
            }""", timeout=10000)
            chat.get_by_role("button", name="Puce", exact=True).click()
            chat.get_by_role("button", name="Agrandir").click()
            expect(chip).to_be_visible()
            self.assertGreater(chip.bounding_box()["width"], before["width"])
            chat.get_by_role("textbox").fill("Tourne la base de deux degrés puis reviens.")
            chat.get_by_role("button", name="Envoyer").click()
            expect(chat.get_by_role("button", name="Jouer en simulation")).to_have_count(0)
            chat.get_by_role("button", name="Faire revoir par Gemini 3.6 Flash").click()
            chat.get_by_role("button", name="Approuver cette version").click()
            # Approving is a two-step in-page confirmation (a native dialog would drop focus and disarm).
            chat.get_by_role("button", name="Confirmer", exact=True).click()
            expect(chat.get_by_role("button", name="Jouer en simulation")).to_be_visible()
            chat.get_by_role("button", name="Fermer la conversation").click()
            page.locator('[data-rb="section-overview"]').click()  # the arm button lives in Pilotage
            page.locator('[data-rb="arm"]').click()
            expect(page.locator('[data-rb="move"]')).to_be_enabled()
            chip.click()
            chat.get_by_role("button", name="Jouer en simulation").click()
            expect(page.locator('[data-rb="message"]')).to_have_text("Script terminé.", timeout=12000)
            expect(chat).to_be_hidden()
            expect(page.locator('[data-rb="actual-base"]')).to_have_text("0.0°")
            page.locator(".bottom-nav [data-nav=plus]").click()
            expect(chip).to_be_hidden()
            browser.close()

    def test_navigation_motion_input_and_cleanup(self):
        from playwright.sync_api import expect, sync_playwright

        with fixture() as (base, _lab), sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            paths = []
            page.on("request", lambda req: paths.append(req.url))
            client = Client(base, ADMIN)
            page.context.add_cookies([{"name": bridge.COOKIE_NAME, "value": client.token, "url": base}])
            page.goto(base, wait_until="domcontentloaded")
            nav = page.locator(".bottom-nav [data-nav=robotique]")
            expect(nav).to_be_visible(timeout=12000)
            self.assertFalse(any("hq-robotics." in path for path in paths))
            nav.click()
            arm = page.locator('[data-rb="arm"]')
            stop = page.locator('[data-rb="stop"]')
            move = page.locator('[data-rb="move"]')
            expect(arm).to_be_enabled(timeout=12000)
            # Section mode opens on Moniteur; a chip shows its own section, then the overview restores
            # every card for the motion flow below.
            expect(page.locator('.rb-workspace > [data-section="camera"]')).to_be_visible(timeout=12000)
            page.locator('[data-go-section="motion"]').click()
            expect(page.locator('.rb-workspace > [data-section="motion"]')).to_be_visible()
            expect(page.locator('.rb-workspace > [data-section="camera"]')).to_be_hidden()
            page.locator('[data-rb="section-overview"]').click()
            expect(page.locator('.rb-workspace > [data-section="camera"]')).to_be_visible()
            expect(move).to_be_disabled()
            expect(page.locator('[data-rb="position-x"]')).to_have_text("310.2")
            page.locator('[data-rb="preview"]').click()
            expect(page.locator('[data-rb="plot-preview"]')).to_be_visible()
            page.locator('#rb-base').fill('3')
            expect(page.locator('[data-rb="plot-preview"]')).to_be_hidden()
            page.locator('[data-monitor="camera"]').click()
            expect(page.locator('[data-rb="video-start"]')).to_be_disabled()
            expect(page.locator('[data-monitor="camera"]')).to_have_attribute("aria-pressed", "true")
            page.locator('[data-monitor="position"]').click()
            arm.click()
            expect(move).to_be_enabled()
            jog = page.locator('[data-step="base"][data-direction="1"]')
            jog.focus()
            page.keyboard.down("Space")
            page.locator('[data-rb="home"]').focus()
            page.keyboard.up("Space")
            self.assertFalse(any(path.endswith("/robotics/move") for path in paths))
            jog.dispatch_event("pointerdown", {"button": 0, "isPrimary": True, "pointerId": 40})
            jog.dispatch_event("pointercancel", {"pointerId": 40})
            jog.dispatch_event("pointerup", {"pointerId": 40})
            self.assertFalse(any(path.endswith("/robotics/move") for path in paths))
            jog.focus()
            jog.press("Space")
            expect(page.locator('[data-rb="actual-base"]')).to_have_text("2.0°", timeout=5000)
            stop.click()
            expect(page.locator('[data-rb="safety"]')).to_have_text("Inspection requise")
            expect(move).to_be_disabled()
            page.locator('[data-rb="reset"]').click()
            expect(arm).to_be_enabled()
            arm.click()
            expect(move).to_be_enabled()
            page.evaluate("window.dispatchEvent(new Event('blur'))")
            # An idle arming survives a blur (docs/robotics.md, « Perte de focus »): only a
            # step, a script or a press disarms; otherwise the 20 s lease lapses on its own.
            page.wait_for_timeout(300)
            expect(move).to_be_enabled()
            expect(arm).to_be_disabled()
            with page.expect_request("**/api/robotics/cancel"):
                page.locator('[data-rb="cancel"]').click()
            expect(arm).to_be_enabled()
            expect(move).to_be_disabled()
            arm.click()
            expect(move).to_be_enabled()
            with page.expect_request("**/api/robotics/cancel"):
                page.locator(".bottom-nav [data-nav=plus]").click()
            expect(page.locator("body")).to_have_attribute("data-view", "plus")
            before = sum("/robotics/status" in path for path in paths)
            page.wait_for_timeout(1100)
            self.assertEqual(before, sum("/robotics/status" in path for path in paths))
            mobile = browser.new_page(viewport={"width": 360, "height": 810}, is_mobile=True, has_touch=True)
            mobile.context.add_cookies([{"name": bridge.COOKIE_NAME, "value": client.token, "url": base}])
            mobile.goto(base + "/#plus", wait_until="domcontentloaded")
            link = mobile.locator('.hq-more-nav [data-view-link="robotique"]')
            expect(link).to_be_visible(timeout=12000)
            link.tap(timeout=8000)
            arm = mobile.locator('[data-rb="arm"]')
            move = mobile.locator('[data-rb="move"]')
            expect(arm).to_be_enabled()
            expect(move).to_be_disabled()
            # The stacking check below needs both cards on screen, not just the Moniteur section.
            expect(mobile.locator('.rb-workspace > [data-section="camera"]')).to_be_visible(timeout=12000)
            mobile.locator('[data-rb="section-overview"]').tap(timeout=8000)
            expect(mobile.locator('.rb-workspace > [data-section="motion"]')).to_be_visible()
            self.assertTrue(mobile.evaluate("""() => {
                const root = document.querySelector('#hq-robotics-app');
                const camera = root.querySelector('.rb-camera').getBoundingClientRect();
                const motion = root.querySelector('.rb-motion').getBoundingClientRect();
                return root.scrollWidth <= root.clientWidth + 1 && camera.bottom <= motion.top;
            }"""))
            # The floating chip is hidden on a phone and the header button scrolls away with the card
            # head, so the sticky bar's entry must stay reachable and open the same chat.
            expect(mobile.locator('.rb-ai-chip')).to_be_hidden()
            ai = mobile.locator('[data-rb="section-ai"]')
            expect(ai).to_be_visible()
            ai.tap(timeout=8000)
            chat = mobile.locator('#hq-robotics-chat')
            expect(chat).to_be_visible(timeout=12000)
            # The context chips mount with the panel, but the opening check-in renders just after and
            # replaces them: wait for that message so the tap cannot race the re-render.
            expect(chat.locator('.rb-ai-message').first).to_be_visible(timeout=12000)
            # The chip rows scroll on a phone: the card must not overflow, the row must announce the
            # hidden content with the page's edge fade, and a chip must still send its text.
            self.assertTrue(mobile.evaluate("""() => {
                const card = document.querySelector('#hq-robotics-chat');
                const row = card.querySelector('.rb-ai-chips');
                return card.scrollWidth <= card.clientWidth + 1 && row.scrollWidth > row.clientWidth + 2 &&
                    row.classList.contains('is-overflow') && getComputedStyle(row).maskImage !== 'none';
            }"""))
            suggestion = mobile.locator('.rb-ai-chips button').first
            text = suggestion.inner_text()
            suggestion.tap(timeout=8000)
            expect(mobile.locator('[data-chat="log"]')).to_contain_text(text, timeout=8000)
            mobile.reload(wait_until="domcontentloaded")
            expect(arm).to_be_enabled(timeout=12000)
            expect(move).to_be_disabled()
            browser.close()

    def test_record_click_waypoints_playback_and_cleanup(self):
        from playwright.sync_api import expect, sync_playwright

        with fixture() as (base, _lab), sync_playwright() as playwright:
            browser = playwright.chromium.launch()
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            client = Client(base, ADMIN)
            page.context.add_cookies([{"name": bridge.COOKIE_NAME, "value": client.token, "url": base}])
            page.goto(base, wait_until="domcontentloaded")
            nav = page.locator(".bottom-nav [data-nav=robotique]")
            expect(nav).to_be_visible(timeout=12000)
            nav.click()
            page.locator('[data-rb="section-overview"]').click()  # arming and recording live in two sections
            arm = page.locator('[data-rb="arm"]')
            expect(arm).to_be_enabled(timeout=12000)
            arm.click()
            expect(page.locator('[data-rb="move"]')).to_be_enabled()
            start = page.locator('[data-rb="record-start"]')
            expect(start).to_be_enabled()
            start.click()
            state = page.locator('[data-rb="record-state"]')
            expect(state).to_have_text("Enregistrement · 0 pose(s)")
            plot = page.locator('[data-rb="plot"]')
            box = plot.bounding_box()
            self.assertTrue(box and box["width"] > 100 and box["height"] > 100)
            plot.click(position={"x": box["width"] / 2 + 12, "y": box["height"] / 2 - 9})
            expect(state).to_have_text("Enregistrement · 1 pose(s)", timeout=15000)
            plot.click(position={"x": box["width"] / 2 - 10, "y": box["height"] / 2 + 8})
            expect(state).to_have_text("Enregistrement · 2 pose(s)", timeout=15000)
            page.locator('[data-rb="record-stop"]').click()
            page.locator('[data-rb="record-name"]').fill("Balayage test")
            page.locator('[data-rb="record-store"]').click()
            card = page.locator(".rb-record").filter(has_text="Balayage test")
            expect(card).to_be_visible(timeout=5000)
            expect(card).to_contain_text("2 poses · ≈")
            card.locator("[data-record-edit]").click()
            self.assertEqual(page.locator(".rb-record-step").count(), 2)
            first = page.locator(".rb-record-step span").nth(0).text_content()
            page.locator('[data-record-step-up="1"]').click()
            self.assertNotEqual(page.locator(".rb-record-step span").nth(0).text_content(), first)
            page.locator("[data-record-step-drop]").first.click()
            expect(page.locator(".rb-record-step")).to_have_count(1)
            page.locator("[data-record-steps-save]").click()
            expect(card).to_contain_text("1 pose · ≈")
            trace = page.locator('[data-rb="plot-trace"]')
            expect(trace).to_be_visible()
            card.locator("[data-record-trace]").click()
            expect(trace).to_be_hidden()
            card.locator("[data-record-trace]").click()
            expect(trace).to_be_visible()
            page.locator('[data-rb="home"]').click()
            expect(page.locator('[data-rb="actual-base"]')).to_have_text("0.0°", timeout=15000)
            play = card.locator("[data-record-play]")
            expect(play).to_be_enabled(timeout=10000)
            play.click()
            playback = page.locator('[data-rb="playback"]')
            expect(playback).to_be_visible()
            expect(page.locator('[data-rb="playback-name"]')).to_have_text("Balayage test")
            expect(page.locator('[data-rb="playback-step"]')).to_have_text("Étape 1 / 1")
            expect(page.locator('[data-rb="playback-remaining"]')).to_have_text("0 restante")
            expect(page.locator('[data-rb="message"]')).to_have_text("Script terminé.", timeout=30000)
            expect(page.locator('[data-rb="plot-trace"]')).to_have_text("Trace")
            expect(playback).to_be_hidden()
            browser.close()

    def test_synthetic_video_and_cleanup(self):
        from playwright.sync_api import expect, sync_playwright

        binary = hq_robotics_camera.executable(bridge.CODE_ROOT)
        ffmpeg = shutil.which("ffmpeg")
        if not binary or not ffmpeg:
            self.skipTest("Requires go2rtc and FFmpeg on the test host")
        with fixture() as (base, lab), sync_playwright() as playwright:
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                port = listener.getsockname()[1]
            config = {"app": {"modules": ["rtsp"]}, "rtsp": {"listen": f"127.0.0.1:{port}"},
                      "streams": {"stream2": None}}
            opts = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
                    "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0)}
            with subprocess.Popen([binary, "-config", json.dumps(config)], **opts) as producer:
                try:
                    deadline = time.monotonic() + 4
                    while True:
                        try:
                            with socket.create_connection(("127.0.0.1", port), timeout=.2):
                                break
                        except OSError:
                            if time.monotonic() >= deadline:
                                raise
                            time.sleep(.05)
                    args = [ffmpeg, "-nostdin", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15",
                            "-an", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
                            "-g", "15", "-f", "rtsp", "-rtsp_transport", "tcp", f"rtsp://127.0.0.1:{port}/stream2"]
                    with subprocess.Popen(args, **opts) as synthetic:
                        try:
                            self.camera_browser(base, lab, playwright, binary, port, synthetic)
                        finally:
                            synthetic.kill()
                finally:
                    producer.kill()

    def camera_browser(self, base, lab, playwright, binary, port, synthetic):
        from playwright.sync_api import expect

        client = Client(base, ADMIN)
        self.assertEqual(post(client, "settings", {"camera_ip": "192.168.2.7",
                                                  "camera_user": "synthetic-user",
                                                  "camera_password": "synthetic-password"})[0], 200)
        browser = playwright.chromium.launch(channel=os.environ.get("HQ_ROBOTICS_H264_CHANNEL", "chrome"))
        page = browser.new_page(viewport={"width": 1440, "height": 960})
        page.context.add_cookies([{"name": bridge.COOKIE_NAME, "value": client.token, "url": base}])
        with (patch.object(hq_robotics, "executable", return_value=binary),
              patch.object(hq_robotics_camera, "executable", return_value=binary),
              patch.object(hq_robotics_camera, "pinned_rtsp", return_value=nullcontext(port))):
            page.goto(base + "/#robotique", wait_until="domcontentloaded")
            page.locator('[data-monitor="camera"]').click()
            start = page.locator('[data-rb="video-start"]')
            note = page.locator('[data-rb="video-note"]')
            expect(start).to_be_enabled(timeout=12000)
            start.click()
            try:
                expect(note).to_have_text("En direct", timeout=12000)
            except AssertionError as exc:
                raise AssertionError(f"{exc}\nPlayer: {page.locator('[data-rb=message]').inner_text()}") from exc
            expect(page.locator('[data-rb="fullscreen"]')).to_be_enabled()
            process = lab.camera.active
            self.assertIsNotNone(process)
            with page.expect_request("**/api/robotics/camera/stop"):
                page.locator('[data-monitor="position"]').click()
            self.assertIsNotNone(process.wait(timeout=5))
            page.locator('[data-monitor="camera"]').click()
            expect(start).to_be_enabled()
            start.click()
            expect(note).to_have_text("En direct", timeout=12000)
            process = lab.camera.active
            with page.expect_request("**/api/robotics/camera/stop"):
                page.locator(".bottom-nav [data-nav=plus]").click()
            self.assertIsNotNone(process.wait(timeout=5))
            page.locator(".bottom-nav [data-nav=robotique]").click()
            page.locator('[data-monitor="camera"]').click()
            expect(start).to_be_enabled()
            synthetic.kill()
            start.click()
            expect(note).to_have_text("Flux interrompu", timeout=12000)
            expect(page.locator('[data-rb="move"]')).to_be_disabled()
        browser.close()


if __name__ == "__main__":
    unittest.main()
