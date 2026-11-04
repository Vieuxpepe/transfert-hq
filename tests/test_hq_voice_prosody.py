import math
import struct
import wave
import threading
from pathlib import Path
from unittest.mock import patch

import hq_voice as voice
from hq_voice_prosody import PROFILES, normalize_style, shape_pauses
from tests.test_hq_ai import Base, DEV
import hq_ai as ai


def write_audio(path, chunks, width=2):
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(width)
        wav.setframerate(16000)
        wav.writeframes(b"".join(chunks))


def tone(ms):
    return b"".join(struct.pack("<h", int(5000 * math.sin(i * .13))) for i in range(ms * 16))


def test_pause_shaping_preserves_voiced_samples_and_does_not_extend_edges(tmp_path):
    path = tmp_path / "voice.wav"
    phrase = tone(400)
    silence = b"\0" * (160 * 16 * 2)
    edge = b"\0" * (200 * 16 * 2)
    write_audio(path, [edge, phrase, silence, phrase, edge])
    assert shape_pauses(path, "thoughtful") == 1
    with wave.open(str(path), "rb") as wav:
        output = wav.readframes(wav.getnframes())
    assert output == edge + phrase + silence + b"\0" * (150 * 16 * 2) + phrase + edge


def test_no_pause_inserted_inside_continuous_speech_or_unsupported_pcm(tmp_path):
    path = tmp_path / "voice.wav"
    write_audio(path, [tone(700)])
    original = path.read_bytes()
    assert shape_pauses(path, "deadpan") == 0
    assert path.read_bytes() == original
    write_audio(path, [b"\x80" * 20000], width=1)
    assert shape_pauses(path, "warm") == 0


def test_pause_count_and_duration_are_bounded(tmp_path):
    path = tmp_path / "voice.wav"
    write_audio(path, [tone(200), b"\0" * 3840] * 10 + [tone(200)])
    assert shape_pauses(path, "thoughtful") == 6
    assert normalize_style("untrusted-filter-string") == "neutral"
    assert normalize_style({"style": "warm"}) == "neutral"
    assert PROFILES["thoughtful"][2] < PROFILES["playful"][2]


def test_mastering_serves_wav_and_does_not_encode_mp3(tmp_path):
    wav = tmp_path / "voice_test.wav"
    mp3 = tmp_path / "voice_test.mp3"
    write_audio(wav, [tone(200)])
    def master(command, **kwargs):
        assert command[-1].endswith(".wav")
        assert "pcm_s24le" in command
        Path(command[-1]).write_bytes(wav.read_bytes())
    with patch.object(voice.os.path, "exists", return_value=True), patch.object(voice.subprocess, "run", side_effect=master) as ffmpeg:
        result = voice._finish(wav, mp3, mp3.name, wav.name, "Test.", "daemon", style="thoughtful")
    assert result["ok"]
    assert result["audio_url"].endswith("master_voice_test.wav")
    assert result["wav_url"] == result["audio_url"]
    assert ffmpeg.call_count == 1
    assert not mp3.exists()


def test_without_ffmpeg_original_wav_remains_available(tmp_path):
    wav = tmp_path / "voice_raw.wav"
    write_audio(wav, [tone(200)])
    with patch.object(voice.os.path, "exists", return_value=False):
        result = voice._finish(wav, tmp_path / "unused.mp3", "unused.mp3", wav.name, "Test.", "daemon")
    assert result["ok"] and result["audio_url"].endswith("voice_raw.wav")
    assert wav.exists()


def test_style_cache_separation_and_single_daemon_generation(tmp_path):
    def synth(text, language, speakers, temp, top_p, output, timeout):
        write_audio(output, [tone(400), b"\0" * 5120, tone(400)])
        return True
    def finish(wav, mp3, name, wav_name, text, engine, **kwargs):
        return {"ok": True, "audio_url": name, "delivery": kwargs["style"]}
    with patch.object(voice, "CACHE_DIR", tmp_path), patch.object(voice, "daemon_ready", return_value=True), \
         patch.object(voice, "_daemon_synthesize", side_effect=synth) as generator, \
         patch.object(voice, "_finish", side_effect=finish), patch.object(voice, "start_daemon") as startup:
        a = voice.synthesize("Je me demande pourquoi les étoiles scintillent.", style="thoughtful")
        b = voice.synthesize("Je me demande pourquoi les étoiles scintillent.", style="playful")
        assert a["audio_url"] != b["audio_url"]
        assert generator.call_count == 2  # one local synthesis per reply, not per sentence
        assert not startup.called


class VoiceEndpointTests(Base):
    def test_delivery_reaches_local_voice_without_provider_calls(self):
        with patch.object(voice, "synthesize", return_value={"ok": True, "audio_url": "/example.mp3"}) as synth:
            code, out = ai.http_post({"action": "transferania", "op": "voice", "device_id": DEV,
                                     "text": "Je me demande pourquoi.", "style": "thoughtful"}, role="admin")
            assert code == 200 and out["ok"]
            assert synth.call_args.kwargs["style"] == "thoughtful"
            assert not self.calls


def test_cold_daemon_never_also_launches_a_second_model(tmp_path):
    with patch.object(voice, "CACHE_DIR", tmp_path), patch.object(voice, "daemon_ready", return_value=False), \
         patch.object(voice, "start_daemon") as startup, patch.object(voice.subprocess, "run") as run:
        result = voice.synthesize("Un essai local de voix.", style="neutral")
        assert not result["ok"]
        assert startup.call_count == 1
        assert not run.called


def test_overlapping_synthesis_returns_busy_instead_of_spawning_another_gpu_job(tmp_path):
    entered, release = threading.Event(), threading.Event()
    def synth(*args):
        entered.set()
        release.wait(5)
        return False
    with patch.object(voice, "CACHE_DIR", tmp_path), patch.object(voice, "daemon_ready", return_value=True), \
         patch.object(voice, "_daemon_synthesize", side_effect=synth) as generate, patch.object(voice, "start_daemon"):
        thread = threading.Thread(target=lambda: voice.synthesize("Premier essai local.", style="warm"))
        thread.start()
        try:
            assert entered.wait(3)
            second = voice.synthesize("Deuxième essai local.", style="warm")
            assert not second["ok"] and "occupée" in second["error"]
            assert generate.call_count == 1
        finally:
            release.set()
            thread.join(5)
