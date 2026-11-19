"""DJ page browser smoke — the parts unit tests cannot see.

Drives the real Musique page in Chromium with its Spotify/DJ APIs stubbed, on the throwaway
loopback HQ from visual_carnet_playwright (temp ROOT, fake PINs); never touches the live root.
Skips (exit 0) when Playwright or Chromium is unavailable.

    python tests/visual_dj_page_playwright.py

Covers: the on-air strip names the song through the shared identity, a blind duel issued by the
station hides the song even without the Musique page having armed it, and a local file in the
Lecteur makes the show step aside.
"""
import sys
import time
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SOURCE))
sys.path.insert(0, str(SOURCE / "tests"))

try:
    from playwright.sync_api import sync_playwright
except Exception:  # pragma: no cover
    print("SKIP: playwright not installed")
    sys.exit(0)

import visual_carnet_playwright as V  # noqa: E402

FAILS = []


def check(ok, msg):
    print(("  OK   " if ok else "  FAIL ") + msg)
    if not ok:
        FAILS.append(msg)


TRACK = {
    "id": "sp-dj-1", "uri": "spotify:track:sp-dj-1", "name": "Soir de test", "artists": ["Transfert"],
    "album": "A", "duration_ms": 180000, "image": None,
}
PLAYER = {
    "ok": True, "playing": True, "progress_ms": 30000, "device": {"id": "dev", "name": "PC"},
    "item": TRACK,
}
STATUS = {"ok": True, "connected": True, "premium": True, "device": {"id": "dev", "name": "PC"}}
SHOW = {
    "ok": True, "active": True,
    "segment": {"id": "seg1", "title": "Nuit", "theme": "calme", "show": "dj",
                "tracks": [dict(TRACK, line="doucement", drop=None)]},
    "next": None, "prep": {"running": False, "pct": 100, "stage": "done"},
    "mood": None, "session_steer": None, "duels": None,
}


def main():
    srv = V.Server()
    hits = []
    try:
        with sync_playwright() as pw:
            h = V.Harness(pw, srv)
            ctx = h.context("desktop", init="localStorage.setItem('hq_companion_nsfw','1')")
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))

            def route(r):
                url = r.request.url
                if "/api/musica/dj/state" in url:
                    return r.fulfill(json=SHOW)
                if "/api/musica/conceal" in url:
                    return r.fulfill(json={"ok": True, "concealed": True, "reason": "duel"})
                if "/api/musica/dj/local" in url:
                    hits.append(url)
                    return r.fulfill(json={"ok": True, "active": False, "left": True})
                if "/api/musica/dj/observe" in url:
                    return r.fulfill(json={"ok": True, "active": True, "drops": []})
                if "/api/spotify/player" in url:
                    return r.fulfill(json=PLAYER)
                if "/api/spotify/status" in url:
                    return r.fulfill(json=STATUS)
                if "/api/spotify/devices" in url:
                    return r.fulfill(json={"ok": True, "devices": [STATUS["device"]]})
                return r.continue_()

            page.route("**/api/**", route)
            page.goto(srv.base + "/?nc=dj1")
            page.evaluate("setView('musique')")
            page.wait_for_selector("#hq-music-app", timeout=20000)
            page.wait_for_selector("[data-hqm='onair-strip']:not([hidden])", timeout=20000)
            page.wait_for_function(
                "() => /Soir de test/.test(document.querySelector(\"[data-hqm='onair-now']\")?.textContent || '')",
                timeout=20000,
            )
            now = page.text_content("[data-hqm='onair-now']") or ""
            check("Soir de test" in now, "the on-air strip names the playing song through the shared identity")

            deadline = time.time() + 22
            concealed = False
            while time.time() < deadline:
                concealed = bool(page.evaluate("window.HqNowPlaying && window.HqNowPlaying.isConcealed()"))
                if concealed:
                    break
                page.wait_for_timeout(400)
            check(concealed, "a blind duel hides the song without the Musique page arming it")

            page.evaluate("window.dispatchEvent(new CustomEvent('hq:local-play', {detail:{playing:true}}))")
            deadline = time.time() + 6
            while time.time() < deadline and not hits:
                page.wait_for_timeout(150)
            check(bool(hits), "a local file in the Lecteur makes the show step aside")
            check(not errors, "no page errors (got %r)" % errors[:3])
            h.close()
    finally:
        srv.close()

    if FAILS:
        print("DJ page: %d failure(s)" % len(FAILS))
        return 1
    print("DJ page: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
