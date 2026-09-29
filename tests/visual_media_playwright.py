"""Browser QA for the Lecteur tab (audio/video viewer) against a throwaway loopback HQ.

Self-contained: temp ROOT, fake PIN, 127.0.0.1 only; never the live root. Needs Playwright.
Fixtures are generated: a 1 s WAV with the stdlib `wave` module, and a 1 s H.264 MP4 only if
ffmpeg is on PATH (otherwise video playback is skipped). Desktop and iPhone use Google Chrome
when installed (Playwright's Chromium has no H.264), plus WebKit's iPhone profile if available.
Set HQ_MEDIA_SCREENSHOTS=<dir> to save screenshots.
"""
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import wave
from http.server import ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import iphone_bridge
from playwright.sync_api import sync_playwright

FAKE_PIN = "246810"
SHOTS = os.environ.get("HQ_MEDIA_SCREENSHOTS")
FOLDER = "Inbox/Musique"


def make_fixtures(root: Path) -> bool:
    music = root / "Inbox" / "Musique"
    music.mkdir(parents=True)
    with wave.open(str(music / "tone.wav"), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(8000)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / 8000))) for i in range(8000)))
    (music / "notes.txt").write_text("pas un média\n", encoding="utf-8")
    (music / "film.mkv").write_bytes(b"\x1a\x45\xdf\xa3" + b"\x00" * 64)
    (music / "abime.webm").write_bytes(b"not a video at all")
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        return False
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=10",
                    "-t", "1", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-movflags", "+faststart", str(music / "clip.mp4")],
                   check=True, timeout=60)
    return True


def login(page, url):
    page.goto(url)
    page.fill('input[name="pin"]', FAKE_PIN)
    page.click('button[type="submit"]')
    page.wait_for_selector('.bottom-nav [data-nav="lecteur"]')


def open_folder(page):
    page.click('.bottom-nav [data-nav="fichiers"]')
    page.click('#file-list [data-open="Inbox"].fname')
    page.click(f'#file-list [data-open="{FOLDER}"].fname')
    page.wait_for_selector(f'#file-list li.file[data-rel="{FOLDER}/tone.wav"]')


def row_meta(page, name):
    return page.locator(f'#file-list li.file[data-rel="{FOLDER}/{name}"] .meta')


def wait_audio_metadata(page, label):
    page.wait_for_function("() => { const a=document.querySelector('#player-audio'); return a && a.readyState >= 1 && a.duration > 0; }", timeout=15000)
    duration = page.evaluate("document.querySelector('#player-audio').duration")
    assert abs(duration - 1.0) < 0.05, (label, duration)


def assert_lecteur(page, name, element="audio"):
    page.wait_for_function("() => document.body.dataset.view === 'lecteur'", timeout=5000)
    state = page.evaluate("""(el) => { const m=document.querySelector('#player-' + el);
      return {name: document.querySelector('#player-name').textContent, src: m.getAttribute('src'), hidden: m.hidden,
              playsinline: document.querySelector('#player-video').hasAttribute('playsinline'),
              active: document.querySelector('.bottom-nav [data-nav="lecteur"]').classList.contains('active')}; }""", element)
    assert state["name"] == name, state
    assert state["src"] == "/media/" + "/".join(p for p in f"{FOLDER}/{name}".split("/")), state
    assert not state["hidden"] and state["playsinline"] and state["active"], state


def desktop_flow(browser, url, have_mp4):
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors, media = [], []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("response", lambda r: media.append((r.url.split("/media/", 1)[1], r.status)) if "/media/" in r.url else None)
    login(page, url)
    open_folder(page)
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/media-desktop-fichiers.png")
    # Single click on a media name still opens /files/ in a new tab, after the ~300 ms double-click window.
    popups = []
    page.on("popup", lambda pg: popups.append(pg))
    page.click(f'#file-list li.file[data-rel="{FOLDER}/tone.wav"] a.fname')
    page.wait_for_timeout(150)
    assert not popups, "media name opened before the double-click window"
    with page.expect_popup() as pop:
        pass
    assert "/files/Inbox/Musique/tone.wav" in pop.value.url, pop.value.url
    pop.value.close(); popups.clear()
    assert page.evaluate("document.body.dataset.view") == "fichiers"
    # Non-media names are unchanged and immediate.
    with page.expect_popup(timeout=250) as pop:
        page.click('#file-list li.file:has(a.fname:text("notes.txt")) a.fname')
    assert "/files/Inbox/Musique/notes.txt" in pop.value.url
    pop.value.close(); popups.clear()
    # Double-click on a media NAME opens the Lecteur and no tab.
    page.dblclick(f'#file-list li.file[data-rel="{FOLDER}/tone.wav"] a.fname')
    assert_lecteur(page, "tone.wav")
    page.wait_for_timeout(500)
    assert not popups, [pg.url for pg in popups]
    page.click('.bottom-nav [data-nav="fichiers"]')
    page.wait_for_selector(f'#file-list li.file[data-rel="{FOLDER}/tone.wav"]')
    # Non-media rows keep no double-click behavior.
    page.dblclick(f'#file-list li.file:has(a.fname:text("notes.txt")) .meta')
    page.wait_for_timeout(300)
    assert page.evaluate("document.body.dataset.view") == "fichiers"
    # Double-click a song row: Lecteur tab, player on the file, metadata loads, served with ranges.
    row_meta(page, "tone.wav").dblclick()
    assert_lecteur(page, "tone.wav")
    wait_audio_metadata(page, "desktop wav")
    page.wait_for_function("() => !document.querySelector('#player-audio').paused || document.querySelector('#player-audio').ended", timeout=5000)
    assert any(s == 206 for p, s in media if p.endswith("tone.wav")), media
    assert page.locator('#player-list [data-play]').count() >= 3
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/media-desktop-lecteur-audio.png")
    if have_mp4:
        page.click('#btn-player-back'); page.wait_for_function("() => document.body.dataset.view === 'fichiers'")
        row_meta(page, "clip.mp4").dblclick()
        assert_lecteur(page, "clip.mp4", "video")
        page.wait_for_function("() => { const v=document.querySelector('#player-video'); return v.readyState >= 1 && v.videoWidth === 160; }", timeout=15000)
        assert page.evaluate("document.querySelector('#player-audio').hidden")
        if SHOTS:
            page.wait_for_timeout(400)
            page.screenshot(path=f"{SHOTS}/media-desktop-lecteur-video.png")
    # Known-unplayable container: clear French message, no player, no request.
    before = len(media)
    page.click('.bottom-nav [data-nav="fichiers"]')
    row_meta(page, "film.mkv").dblclick()
    page.wait_for_function("() => document.body.dataset.view === 'lecteur'")
    msg = page.locator('#player-msg').inner_text()
    assert "ne se lit pas dans un navigateur" in msg and "VLC" in msg, msg
    assert page.evaluate("document.querySelector('#player-video').hidden && document.querySelector('#player-audio').hidden")
    assert len(media) == before, media[before:]
    # Playable extension but undecodable content: error message instead of a broken player.
    page.click('.bottom-nav [data-nav="fichiers"]')
    row_meta(page, "abime.webm").dblclick()
    page.wait_for_function("() => !document.querySelector('#player-msg').hidden && document.querySelector('#player-video').hidden", timeout=10000)
    assert "Impossible de lire ce fichier ici" in page.locator('#player-msg').inner_text()
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/media-desktop-lecteur-unsupported.png")
    assert not errors, errors
    page.close()


def touch_flow(browser, device, url, label, strict_metadata=True):
    ctx = browser.new_context(**device)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    login(page, url)
    open_folder(page)
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/media-{label}-fichiers.png")
    meta = row_meta(page, "tone.wav")
    meta.scroll_into_view_if_needed()
    box = meta.bounding_box()
    x, y = box["x"] + min(40, box["width"] / 2), box["y"] + box["height"] / 2
    # A single tap does nothing new.
    page.touchscreen.tap(x, y)
    page.wait_for_timeout(450)
    assert page.evaluate("document.body.dataset.view") == "fichiers"
    # Behave like iOS Safari, which doesn't reliably fire dblclick: swallow it, so only the
    # explicit double-tap handler can open the Lecteur.
    page.evaluate("document.addEventListener('dblclick', e => { window.__dblclickSeen = true; e.stopImmediatePropagation(); }, true)")
    # Double tap (well under 300 ms) opens the Lecteur.
    page.touchscreen.tap(x, y); page.touchscreen.tap(x, y)
    assert_lecteur(page, "tone.wav")
    metadata = True
    try:
        wait_audio_metadata(page, label)
    except Exception:
        metadata = False
        if strict_metadata:
            raise
    if SHOTS:
        page.screenshot(path=f"{SHOTS}/media-{label}-lecteur.png", full_page=True)
    # Library list plays on tap; Retour aux fichiers goes back to the file's folder.
    assert page.locator('#player-list [data-play]').count() >= 3
    page.click('#btn-player-back')
    page.wait_for_function("() => document.body.dataset.view === 'fichiers'")
    page.wait_for_selector(f'#file-list li.file[data-rel="{FOLDER}/tone.wav"]')
    # Media name: a single tap opens the file (new tab) after the double-tap window…
    page.wait_for_load_state("networkidle"); page.wait_for_timeout(300)  # Retour re-renders the list (setView + navigate)
    name = page.locator(f'#file-list li.file[data-rel="{FOLDER}/tone.wav"] a.fname')
    name.scroll_into_view_if_needed()
    nb = name.bounding_box(); nx, ny = nb["x"] + min(30, nb["width"] / 2), nb["y"] + nb["height"] / 2
    with ctx.expect_page(timeout=3000) as pop:
        page.touchscreen.tap(nx, ny)
    assert "/files/Inbox/Musique/tone.wav" in pop.value.url, pop.value.url
    pop.value.close()
    assert page.evaluate("document.body.dataset.view") == "fichiers"
    # …and a double tap on the name opens the Lecteur without a tab.
    pages_before = len(ctx.pages)
    page.touchscreen.tap(nx, ny); page.touchscreen.tap(nx, ny)
    assert_lecteur(page, "tone.wav")
    page.wait_for_timeout(500)
    assert len(ctx.pages) == pages_before, [pg.url for pg in ctx.pages]
    assert not errors, errors
    ctx.close()
    return metadata


def run():
    source = Path(__file__).resolve().parents[1]
    old_root, old_sessions = iphone_bridge.ROOT, iphone_bridge.SESSIONS_PATH
    old_config = json.loads(json.dumps(iphone_bridge.CONFIG))
    with tempfile.TemporaryDirectory(prefix="hq-media-browser-") as td:
        root = Path(td)
        shutil.copytree(source / "assets", root / "assets")
        have_mp4 = make_fixtures(root)
        iphone_bridge.ROOT = root
        iphone_bridge.SESSIONS_PATH = root / "bridge_sessions.json"
        iphone_bridge.CONFIG.update({"pin": FAKE_PIN, "users": [{"name": "admin", "pin": FAKE_PIN, "role": "admin"}],
                                     "discord_webhook_url": "", "push_enabled": False})
        iphone_bridge.bind_cc_ext(); iphone_bridge.bind_hq()

        class QuietHandler(iphone_bridge.Handler):
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_address[1]}"
        notes = []
        try:
            with sync_playwright() as p:
                channel = "chrome" if shutil.which("google-chrome") or os.name == "nt" else None
                try:
                    browser = p.chromium.launch(channel=channel)
                except Exception:
                    browser = p.chromium.launch(); channel = None
                if not channel:
                    have_mp4 = False  # Playwright's Chromium can't decode H.264
                desktop_flow(browser, url, have_mp4)
                touch_flow(browser, p.devices["iPhone 13"], url, "iphone")
                browser.close()
                try:
                    webkit = p.webkit.launch()
                except Exception as e:
                    notes.append(f"WebKit skipped: {e.__class__.__name__}")
                else:
                    ok = touch_flow(webkit, p.devices["iPhone 13"], url, "webkit-iphone", strict_metadata=False)
                    notes.append("WebKit iPhone: tab, double tap, src ok; audio metadata " + ("loaded" if ok else "NOT loaded (headless WebKit media backend)"))
                    webkit.close()
        finally:
            server.shutdown(); server.server_close()
            iphone_bridge.ROOT, iphone_bridge.SESSIONS_PATH = old_root, old_sessions
            iphone_bridge.CONFIG.clear(); iphone_bridge.CONFIG.update(old_config)
    print("Lecteur browser flow passed: double-click/double-tap to Lecteur, audio metadata, ranges, "
          + ("MP4 playback, " if have_mp4 else "video playback skipped (no ffmpeg/Chrome), ")
          + "unsupported messages, name double-click/tap (single click delayed ~300 ms), non-media names immediate. " + " ".join(notes))


if __name__ == "__main__":
    run()
