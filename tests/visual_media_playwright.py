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


def tile(page, name):
    return page.locator(f'#hq-files-app .fx-item[data-rel="{FOLDER}/{name}"]')


def open_folder(page):
    page.click('.bottom-nav [data-nav="fichiers"]')
    page.click('#hq-files-app .fx-folder[data-rel="Inbox"]')
    page.click(f'#hq-files-app .fx-folder[data-rel="{FOLDER}"]')
    page.wait_for_selector(f'#hq-files-app .fx-item[data-rel="{FOLDER}/tone.wav"]')


def row_meta(page, name):
    return tile(page, name).locator(".fx-meta")


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
    popups = []
    page.on("popup", lambda pg: popups.append(pg))
    # A single click on a song waits out the double-click window, then opens the quick look (never a new tab).
    tile(page, "tone.wav").click()
    page.wait_for_timeout(120)
    assert page.locator(".fx-sheet.is-ql").count() == 0, "quick look opened inside the double-click window"
    page.wait_for_selector(".fx-sheet.is-ql .fx-ql-audio", timeout=3000)
    assert page.locator('.fx-sheet.is-ql a[href="/files/Inbox/Musique/tone.wav"]').count() == 1, "« Ouvrir » keeps the /files/ link"
    assert page.locator(".fx-sheet.is-ql .fx-btn", has_text="Lecteur").count() == 1
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('.fx-sheet')")
    # Other files open their quick look at once.
    tile(page, "notes.txt").click()
    page.wait_for_selector(".fx-sheet.is-ql .fx-ql-text", timeout=1000)
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('.fx-sheet')")
    # Double-click on a song opens the Lecteur: no quick look, no tab.
    tile(page, "tone.wav").dblclick()
    assert_lecteur(page, "tone.wav")
    page.wait_for_timeout(500)
    assert not popups, [pg.url for pg in popups]
    assert page.locator(".fx-sheet").count() == 0
    page.click('.bottom-nav [data-nav="fichiers"]')
    page.wait_for_selector(f'#hq-files-app .fx-item[data-rel="{FOLDER}/tone.wav"]')
    # Other files keep no double-click behavior (just their quick look).
    tile(page, "notes.txt").dblclick()
    page.wait_for_timeout(300)
    assert page.evaluate("document.body.dataset.view") == "fichiers"
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('.fx-sheet')")
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
    card = tile(page, "tone.wav")
    card.evaluate("el => el.scrollIntoView({ block: 'center' })")  # clear of the fixed bottom nav
    page.wait_for_timeout(300)
    box = card.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 3
    # Behave like iOS Safari, which doesn't reliably fire dblclick: swallow it, so only the
    # tap counting can open the Lecteur.
    page.evaluate("document.addEventListener('dblclick', e => { window.__dblclickSeen = true; e.stopImmediatePropagation(); }, true)")
    # A single tap opens the quick look (after the double-tap window), still in Fichiers.
    page.touchscreen.tap(x, y)
    page.wait_for_selector(".fx-sheet.is-ql .fx-ql-audio", timeout=3000)
    assert page.evaluate("document.body.dataset.view") == "fichiers"
    page.keyboard.press("Escape")
    page.wait_for_function("() => !document.querySelector('.fx-sheet')")
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
    page.wait_for_selector(f'#hq-files-app .fx-item[data-rel="{FOLDER}/tone.wav"]')
    page.wait_for_load_state("networkidle"); page.wait_for_timeout(500)  # Retour re-renders the folder
    # From the quick look, « Lecteur » plays the song.
    t = tile(page, "tone.wav")
    t.evaluate("el => el.scrollIntoView({ block: 'center' })")
    page.wait_for_timeout(300)
    b = t.bounding_box()
    page.touchscreen.tap(b["x"] + b["width"] / 2, b["y"] + b["height"] / 3)
    page.wait_for_selector(".fx-sheet.is-ql .fx-btn:has-text('Lecteur')", timeout=3000)
    pages_before = len(ctx.pages)
    page.locator(".fx-sheet.is-ql .fx-btn", has_text="Lecteur").tap()
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
