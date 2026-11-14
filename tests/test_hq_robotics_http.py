"""Authenticated HQ HTTP and browser flow on a temporary simulation bridge."""

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
from tests.test_hq_diagnostics_http import Client

ADMIN, UPLOAD = "58390241", "97415682"


@contextmanager
def fixture():
    with tempfile.TemporaryDirectory(prefix="hq-robotics-http-") as folder:
        root = Path(folder)
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
        with (fixture() as (base, _), sync_playwright() as p,
              patch.object(assistant.hq_ai, "generate", side_effect=[
                  (json.dumps(draft), assistant.DRAFT_MODELS[0]),
                  (json.dumps(review), assistant.REVIEW_MODELS[0]),
              ])):
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
            chat.get_by_role("button", name="Puce", exact=True).click()
            chat.get_by_role("button", name="Agrandir").click()
            expect(chip).to_be_visible()
            self.assertGreater(chip.bounding_box()["width"], before["width"])
            chat.get_by_role("textbox").fill("Tourne la base de deux degrés puis reviens.")
            chat.get_by_role("button", name="Envoyer").click()
            expect(chat.get_by_role("button", name="Jouer en simulation")).to_have_count(0)
            chat.get_by_role("button", name="Faire revoir par Gemini 3.6 Flash").click()
            chat.get_by_role("button", name="Approuver cette version").click()
            expect(chat.get_by_role("button", name="Jouer en simulation")).to_be_visible()
            chat.get_by_role("button", name="Fermer la conversation").click()
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
            expect(move).to_be_disabled()
            expect(arm).to_be_enabled()
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
            self.assertTrue(mobile.evaluate("""() => {
                const root = document.querySelector('#hq-robotics-app');
                const camera = root.querySelector('.rb-camera').getBoundingClientRect();
                const motion = root.querySelector('.rb-motion').getBoundingClientRect();
                return root.scrollWidth <= root.clientWidth + 1 && camera.bottom <= motion.top;
            }"""))
            mobile.reload(wait_until="domcontentloaded")
            expect(arm).to_be_enabled(timeout=12000)
            expect(move).to_be_disabled()
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
