# ElevenLabs audio generation

Run the examples from the Transfert repository root. HQ keeps its API key in
the gitignored `.hq-music/elevenlabs.json`. The server loader in
[`hq_voice_elevenlabs.py`](../hq_voice_elevenlabs.py) also accepts
`ELEVENLABS_API_KEY` as a fallback. Keep the key in local process memory and
out of command arguments, logs, manifests, and browser code. Generation requests
consume credits. An audition of one take is enough to check a new prompt, voice,
or model before batching.

## Generate a bracketed cue with V4 Turbo

Send square-bracket audio cues as text to the text-to-speech endpoint with a
voice ID and `model_id: eleven_v4_turbo`. Short cues like
`[quiet amused chuckle]`, `[soft gasp]`, and `[dry relay click]` can be
auditioned the same way. For a tag-only prompt, the existing batch helper appends
` ...`. Listen for the intended sound, timing, and any spoken words before
choosing a take. Rendering depends on the prompt, voice, and model.

This PowerShell example uses the stored key and configured Musica voice to
generate one preview. For another character, pass that character's ElevenLabs
voice ID explicitly to `synthesize`.

```powershell
@'
from pathlib import Path
import sys

sys.path.insert(0, "scripts")
from generate_elevenlabs_sound_design import normalize_prompt, synthesize
from hq_voice_elevenlabs import load_config

config = load_config(Path(".hq-music/elevenlabs.json"))
if config is None:
    raise SystemExit("ElevenLabs key is unavailable")

output = Path("artifacts/elevenlabs-tag-samples/musica-hum-turbo.mp3")
output.parent.mkdir(parents=True, exist_ok=True)
if output.exists():
    raise SystemExit(f"Preview already exists: {output}")

audio = synthesize(
    config["api_key"],
    config["voice_id"],
    "eleven_v4_turbo",
    normalize_prompt("[hums a short two-note phrase]"),
    {"voice_settings": config["voice_settings"]},
)
output.write_bytes(audio)
print(output)
'@ | python -
```

The existing `scripts/elevenlabs_tag_samples.py` and
`scripts/generate_elevenlabs_sound_design.py` CLI entry points read
`ELEVENLABS_API_KEY` and select their TTS model from
`scripts/elevenlabs_sound_design_catalog.json`, which currently specifies
`eleven_v4`. The example explicitly selects Turbo for the audition.

For foley or other effects that need explicit duration and prompt influence,
the existing [text-to-sound generator](../scripts/generate_tit_pull_variants.py)
shows how to call `/v1/sound-generation` with `eleven_text_to_sound_v3`.
Reuse its request helper for auditions. Its CLI integrates clips into the
companion bank.

## Install a take in HQ

- **Assistant chips.** Put the clip under `assets/assistant-sfx/<id>/` and add
  an entry with `url` and measured `duration_ms` to the event array under
  `samples` in that bank's `manifest.json`. Use `ffprobe` to verify the
  duration is 150–6000 ms. The player accepts OGG, MP3, M4A and WAV. Use a
  fingerprinted OGG for new deliveries and listen at the actual trigger.
  Check which events the target chip calls. `ack` is accepted by the player
  but currently has no chip caller. Run `node tests/check_assistant_sfx.mjs`.
  [Player and manifest validation](../assets/hq-assistant-sfx.js)
- **Transferania reactions.** Use the existing companion import and mastering
  workflow. A cue such as `[moan]` for an adult interaction belongs on an
  existing adult-gated route. Follow the companion guide for the full manifest,
  runtime manifest, and fingerprinted OGG delivery.
  [Companion voice workflow](companion-voice.md)
- **Musica's live DJ lines.** The server adapter defaults to
  `eleven_v4_turbo` and accepts a local config override. It strips its known
  mood markers, keeps sound cues, and can fall back to local synthesis.
  [ElevenLabs voice adapter](../hq_voice_elevenlabs.py)
