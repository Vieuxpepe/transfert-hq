"""Phonon engine integration tests. The stub-daemon tests exercise the real HTTP/cache/mastering
path; `test_real_daemon_*` runs real synthesis when the warm Phonon daemon is available."""
import io
import json
import math
import struct
import threading
import wave
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import pytest

import hq_voice
import hq_voice_phonon as ph


def _tone_wav(seconds=0.6, rate=24000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(9000 * math.sin(i / 20))) for i in range(int(rate * seconds))))
    return buf.getvalue()


class _Stub(BaseHTTPRequestHandler):
    mode = "ok"
    calls = []

    def log_message(self, *a):
        pass

    def do_GET(self):
        body = json.dumps({"ready": True, "models": {"fr": {}, "en": {}}}).encode()
        self.send_response(200); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def do_POST(self):
        req = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        type(self).calls.append(req)
        if type(self).mode == "busy":
            self.send_response(429); self.send_header("Content-Length", "0"); self.end_headers(); return
        data = b"RIFFxxxx" if type(self).mode == "garbage" else _tone_wav()
        self.send_response(200); self.send_header("Content-Length", str(len(data))); self.end_headers(); self.wfile.write(data)


@pytest.fixture
def stub(tmp_path, monkeypatch):
    srv = HTTPServer(("127.0.0.1", 0), _Stub)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    _Stub.mode, _Stub.calls = "ok", []
    monkeypatch.setattr(ph, "PHONON_URL", f"http://127.0.0.1:{srv.server_port}")
    monkeypatch.setattr(ph, "CACHE_DIR", tmp_path / "cache")
    monkeypatch.setattr(ph, "PROFILES_FILE", tmp_path / "profiles.json")
    monkeypatch.setattr(ph, "FFMPEG_BIN", "missing-ffmpeg")
    monkeypatch.setattr(ph, "_catalog_cache", [
        {"name": "Coralie", "language": "fr", "description": "d"},
        {"name": "Noémie", "language": "fr", "description": "d"},
        {"name": "Zoey", "language": "en", "description": "d"}])
    yield _Stub
    srv.shutdown()


def test_default_routing_and_no_accidental_shared_voice(stub):
    assert ph.route("else") == "xtts"
    assert ph.route("transferina") == "phonon" and ph.route("inventoria") == "phonon" and ph.route("musica") == "phonon"
    assert ph.route(None) == "xtts"  # legacy callers unchanged
    profs = ph.load_profiles()
    assert all(profs[c]["selected"] is False and profs[c]["voice"] is None for c in ("transferania", "inventoria", "musica"))
    previews = {profs[c]["preview_voice"] for c in ("transferania", "inventoria", "musica")}
    assert len(previews) == 3


def test_save_persists_and_validates(stub):
    ph.save_profile("musica", "phonon", "noemie", 0.1)  # accent/case-insensitive
    assert ph.load_profiles()["musica"]["voice"] == "Noémie" or ph.load_profiles()["musica"]["voice"] == "noemie"
    assert ph.load_profiles()["musica"]["selected"] is True
    with pytest.raises(ValueError):
        ph.save_profile("musica", "phonon", "Nobody", 0)
    with pytest.raises(ValueError):
        ph.save_profile("musica", "xtts", None, 0)  # XTTS is Else-only
    assert ph.load_profiles()["transferania"]["voice"] is None  # independent
    ph.reset_profile("musica")
    assert ph.load_profiles()["musica"]["voice"] is None


def test_synthesis_cache_and_isolation(stub):
    r1 = hq_voice.synthesize("Coucou mon Maître, ça va ?", character="transferania", voice="Coralie")
    assert r1["ok"] and r1["engine"] == "phonon" and r1["cached"] is False and r1["preview"] is True
    assert {"audio_url", "wav_url", "visemes", "text", "delivery"} <= set(r1)
    assert len(r1["visemes"]) > 3
    assert ph.wav_ok(ph.CACHE_DIR / Path(r1["audio_url"]).name)
    r2 = hq_voice.synthesize("Coucou mon Maître, ça va ?", character="transferania", voice="Coralie")
    assert r2["cached"] is True and len(stub.calls) == 1
    r3 = hq_voice.synthesize("Coucou mon Maître, ça va ?", character="musica", voice="Noémie")
    assert r3["audio_url"] != r1["audio_url"]
    r4 = hq_voice.synthesize("Coucou mon Maître, ça va ?", character="transferania", voice="Coralie", rate=0.2)
    assert r4["audio_url"] != r1["audio_url"]
    assert "/voice_ph" in r1["audio_url"]  # never collides with xtts voice_<md5> names


def test_failures_never_fall_back_to_xtts(stub, monkeypatch):
    called = []
    monkeypatch.setattr(hq_voice, "_synthesize_xtts", lambda *a, **k: called.append(1))
    stub.mode = "busy"
    r = hq_voice.synthesize("Une phrase assez longue.", character="inventoria", voice="Coralie")
    assert r["ok"] is False and r["engine"] == "phonon" and r["code"] == "busy"
    stub.mode = "garbage"
    r = hq_voice.synthesize("Une autre phrase longue.", character="inventoria", voice="Coralie")
    assert r["ok"] is False and r["code"] == "bad_audio"
    r = hq_voice.synthesize("Une phrase.", character="inventoria", voice="Inconnue")
    assert r["code"] == "bad_voice"
    r = hq_voice.synthesize("Une phrase.", character="inventoria", language="en", voice="Coralie")
    assert r["code"] == "bad_voice"  # French voice is not valid for English
    assert called == []


def test_daemon_down_reports_preparing(stub, monkeypatch):
    monkeypatch.setattr(ph, "PHONON_URL", "http://127.0.0.1:9")
    monkeypatch.setattr(ph, "start_daemon", lambda *a, **k: False)
    r = hq_voice.synthesize("Bonjour tout le monde", character="transferania", voice="Coralie")
    assert r["ok"] is False and r["code"] == "preparing" and "navigateur" in r["error"]


def test_concurrent_requests_all_succeed_or_report_busy(stub):
    out = []
    def go(i):
        out.append(hq_voice.synthesize(f"Phrase numéro {i} pour le test.", character="musica", voice="Noémie"))
    ts = [threading.Thread(target=go, args=(i,)) for i in range(6)]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert len(out) == 6 and all(r["ok"] or r["code"] == "busy" for r in out)


def test_browser_engine_and_else_unchanged(stub, monkeypatch):
    ph.save_profile("inventoria", "browser", None, 0)
    r = hq_voice.synthesize("Bonjour tout le monde", character="inventoria")
    assert r["ok"] is False and r["engine"] == "browser"
    sentinel = {"ok": True, "cached": True}
    monkeypatch.setattr(hq_voice, "_synthesize_xtts", lambda *a, **k: sentinel)
    assert hq_voice.synthesize("Bonjour Maître", character="else") is sentinel
    assert hq_voice.synthesize("Bonjour Maître") is sentinel


def test_studio_preview_is_non_destructive_and_save_needs_admin(stub):
    before = ph.PROFILES_FILE.exists()
    r = ph.studio("voice_preview", {"character": "musica", "voice": "Noémie", "text": "Salut tout le monde"}, admin=False)
    assert r["ok"] and ph.PROFILES_FILE.exists() == before
    r = ph.studio("voice_save", {"character": "musica", "engine": "phonon", "voice": "Noémie"}, admin=False)
    assert r["ok"] is False and r["code"] == "forbidden"
    r = ph.studio("voice_preview", {"character": "musica", "engine": "xtts", "text": "x" * 10}, admin=True)
    assert r["ok"] is False  # XTTS is Else-only
    r = ph.studio("voice_profiles", {}, admin=False)
    assert r["ok"] and set(r["profiles"]) == set(ph.CHARACTERS)


def test_real_daemon_synthesis_english():
    if not ph.daemon_ready("en"):
        pytest.skip("Phonon daemon not running")
    voice = next(v["name"] for v in ph.voices("en"))
    r = ph.synthesize("This is a real local synthesis check.", character="inventoria", language="en", voice=voice)
    assert r["ok"], r
    path = ph.CACHE_DIR / Path(r["audio_url"]).name
    assert ph.wav_ok(path)
    with wave.open(str(path)) as w:
        assert w.getnframes() / w.getframerate() > 1.0


def test_real_daemon_speed_control_changes_duration():
    if not ph.daemon_ready("en"):
        pytest.skip("Phonon daemon not running")
    voice = ph.voices("en")[0]["name"]
    d = {}
    for delta in (-0.3, 0.3):
        r = ph.synthesize("Hello there, this is a test of the speed control.", character="inventoria",
                          language="en", voice=voice, rate=delta, master=False)
        assert r["ok"], r
        with wave.open(str(ph.CACHE_DIR / Path(r["audio_url"]).name)) as w:
            d[delta] = w.getnframes() / w.getframerate()
    assert d[0.3] > d[-0.3] * 1.15


def test_pitch_is_saved_clamped_and_part_of_cache_key(stub):
    ph.save_profile("musica", "phonon", "Noémie", 0.1, 99)
    assert ph.load_profiles()["musica"]["pitch"] == 6.0
    assert ph.cache_key("t", "fr", "v", "neutral", 0.0, "m", 0.0) != ph.cache_key("t", "fr", "v", "neutral", 0.0, "m", 3.0)


def test_english_only_voice_in_profile_selects_english_model(stub):
    ph.save_profile("inventoria", "phonon", "Zoey", 0.0, 0)
    r = hq_voice.synthesize("Bonjour tout le monde", character="inventoria", language="fr")
    assert r["ok"] and r["voice"] == "Zoey" and r["language"] == "en"
