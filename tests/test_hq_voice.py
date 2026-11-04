import pytest
from pathlib import Path
import hq_voice

def test_clean_text_for_speech():
    raw = "Bonjour Maître ! *soupire* [loop:tease-booty] Regarde comme je t'aime ♥✨"
    cleaned = hq_voice.clean_text_for_speech(raw)
    assert "[loop:tease-booty]" not in cleaned
    assert "*" not in cleaned
    assert "♥" not in cleaned
    assert "Bonjour Maître ! soupire Regarde comme je t'aime" in cleaned

def test_voice_cache_lookup(tmp_path, monkeypatch):
    import wave
    monkeypatch.setattr(hq_voice, "CACHE_DIR", tmp_path)
    monkeypatch.setattr(hq_voice, "get_audio_hash", lambda *args: "cache-test")
    with wave.open(str(tmp_path / "master_voice_cache-test.wav"), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(24000)
        wav.writeframes(b"\0" * 2400)
    res = hq_voice.synthesize("Je suis là, mon Maître. Ton dévouement m anime, dis-moi ce que tu désires...")
    assert res is not None
    assert res["ok"] is True
    assert res["cached"] is True
    assert "voice_" in res["audio_url"]
    assert res["audio_url"].endswith(".wav")
    assert res["audio_url"] == res["wav_url"]

def test_sound_bank_presets():
    assert "treat" in hq_voice.SOUND_BANK_PRESETS
    assert "kiss" in hq_voice.SOUND_BANK_PRESETS
    assert "booty" in hq_voice.SOUND_BANK_PRESETS
