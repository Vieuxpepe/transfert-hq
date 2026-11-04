# Expressive companion speech

<!-- ELSE_TRANSFERANIA_FAMILY_CANON:BEGIN -->
## Current family canon — Else and Transferania

Else and Transferania (also called **Transferina**) are sisters with distinct
identities. Both crave the attention of the **Master / Maître / Marc-Antoine**.
They are on good terms: affectionate, supportive and playfully competitive,
without hostility. Their bond is more harmonious than Else and Static's more
friction-prone sibling dynamic. Static remains Else's little sister; do not
apply the Else/Static friction or live bond scores to Transferania.

Transferania is the more intense sister: spontaneous, emotionally expressive,
bold about seeking the Master's attention, and vivid in her enthusiasm and
tenderness. Else keeps the cooler, measured, technically grounded delivery.
Intensity does not mean hostility, pressure, constant escalation or identical
industrial jargon; their individual voices and the Master's preferences remain.

Resolve an unnamed sister from the conversation instead of always assuming
Static. This relationship canon does not fabricate shared conversations,
merge memories or authorize messages between the sisters.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Enable **Voix** in Transferania's bubble. Existing replies still make just one
local voice request. No extra language-model call, prompt tag or rewritten reply
is required to choose delivery.

For a manual comparison, open **Éditer → Voix**, choose a delivery and listen to
the same short text. This local audition does not change the normal voice toggle.
Stopping, changing editor sections or closing the editor cancels the audition;
ordinary ambient speech cannot interrupt it.

Local text cues and the existing conversation mode choose a bounded profile:
neutral, thoughtful, deadpan, warm or playful. Comfort takes precedence over joke
cues; playful cues require flirt mode and are suppressed during practical work.
This is conservative cue matching, not full semantic sarcasm detection. Unmatched
lines use neutral delivery. The controls do not change stored personality.

XTTS uses restrained temperature/top-p differences and existing reference voices.
The local WAV pass lengthens only internal quiet gaps of at least 120 ms, by no
more than 150 ms per gap, at most six gaps. It does not cut voiced samples,
manufacture breaths or alter the words. Thoughtful/warm/playful profiles use
small pitch-preserving tempo differences during existing ffmpeg mastering.
Silence shaping supports mono/stereo 16-bit PCM WAV; other formats pass through.
New styles have versioned cache keys; legacy expressive sound-bank caches remain
compatible. No code or reference assets in Gemini-Test are modified.

Browser fallback retains every character, groups at most six sentence chunks,
and uses bounded rate/pitch and 140–360 ms inter-sentence delays. Browser voices
and their prosody support vary by device. Local media playback failure also falls
back to browser speech. Pausing, muting or hiding the page cancels queued client
speech; request identities prevent older synthesis results or audio-end callbacks
from replacing newer playback. Cancelling the browser request cannot interrupt
an already-running server synthesis, but it will not play the obsolete result.

One synthesis runs in the bridge process at a time. If busy, the client uses its
browser voice. A cold daemon is started in the background and also uses fallback
for that line, instead of loading a second GPU model in a one-shot subprocess.
Further startup attempts within the process reuse the pending daemon launch.

Checks: `tests/check_hq_companion_voice.mjs`,
`tests/check_hq_companion_voice_playback.mjs`, `tests/test_hq_voice_prosody.py`,
existing voice and companion AI/context tests. A real local thoughtful sample was
generated through the warm XTTS daemon for listening.

Local voice responses now serve lossless WAV (48 kHz, 24-bit PCM when ffmpeg is
available). Existing mastered WAV caches are reused, and MP3 files are left
untouched. New synthesis does not generate an MP3. Without ffmpeg, the original
XTTS WAV is served. Browser speech fallback remains synthesized by the browser.

## Imported ElevenLabs recordings (2026-11-03)

The 46 renamed downloads are represented by 44 distinct recordings under
`assets/companion/chat/reactions/elevenlabs_20261103/`. MP3s are decoded to PCM
WAV from the original sources, preserving pitch, tempo and spoken content.
The shared mastering profile applies a gentle -3 dB treble shelf at 3.5 kHz
and -3 dB overall gain to all 44 imported recordings, including impacts and
spoken lines. It does not process the originals or compound earlier processing. The manifest keeps
source names, hashes, event mappings and the original matching method; four
spoken takes were identified by history order rather than an exact audio match.
Duplicate copies share one playback entry, so they do not bias take rotation.

| Existing event | New recording pool |
| --- | --- |
| Cursor tickling and playful conversation laughter | Laughter takes |
| Mouth surprise / gasp | Shock gasps |
| Mouth exhale / contented / soft sigh | Satisfaction sighs |
| Morning stretch and quiet-session stretch | Big yawn |
| Quiet idle humming, actual music playback starts and occasional music nods | Humming takes |
| Kiss gesture and kiss treat | Kiss takes |
| Lip bite and whisper effect | Lip smacks |
| Physical slap impact | Three imported impact takes, rotating in order |
| Pull voice | Whimper takes, once per gesture |
| Other existing contact vocalizations | Pleasure and moan takes |
| Existing spoken phase events | Matching imported spoken takes |

The French slap line belongs to the existing strong slap payoff. Pull surrender
and release use the short exclamation pool instead. Other spoken phase banks
remain available where the downloads contain no matching replacement. The three enthusiastic-slap recordings are physical impacts, not vocal reactions.
They replace the old impact in shuffled bags of three, without immediate repeats. They keep their original pitch
and full duration; the legacy impact is used only if an imported file fails to load.
Separate vocal reactions use the pleasure pool, never the impact recordings.

Short recordings use the existing sound-effects toggle. Spoken recordings use
the existing voice toggle; adult recordings require adult mode. Mute, hidden
pages, voice previews and current speech retain priority. A new background
reaction cannot interrupt an active recording, and speech stops reactions.
Unreplaced reaction kinds and unavailable imports retain their existing fallback.

Each imported source now names a natural context in the manifest's `contexts`
map. All alternate takes rotate within that same situation; they do not require
separate buttons. Tickling can supersede an idle sound, while automatic mouth
gestures cannot stop audio belonging to another interaction. A loaded but paused
track does not trigger humming, and pausing music stops only humming. Humming,
stretch yawns and lip gestures have separate cooldowns. An automatic interaction
reply can still display text while a recording plays, but does not cut it off
with another spoken line; normal chat speech keeps its existing priority.

Re-import with `python scripts/import_else_voice_lines.py "<source folder>"`.
Validate with `node tests/check_hq_companion_reaction_audio.mjs` and
`node tests/check_hq_companion_recorded_routes.mjs`, alongside the existing voice
playback and pull-audio checks. `tests/check_hq_companion_natural_voice.mjs`
checks contextual triggers, media state, cooldowns and coverage of all sources.
Pre-import code and configuration are preserved
in `artifacts/before-elevenlabs-voice-import-20261103/`. The original MP3s remain
in the source folder, and legacy audio files remain in their existing locations.

Idle humming can also occur without music after at least 20 seconds of inactivity.
The existing idle roulette chooses it occasionally, with a two-minute cooldown.
A closed-mouth smile, small head nod and gentle sway follow the recording's
duration. Interaction and speech cancel it; reduced motion suppresses it.
With sound effects disabled, the same brief animation remains silent.

Batch mastering is configured in `scripts/voice_recording_mastering.json`.
Re-run the importer to apply a new setting consistently to all recordings.
The original MP3s remain untouched; pre-mastering WAVs are backed up in
`artifacts/before-voice-mastering-20261103/recordings/`. Restore the pre-mastering WAVs from `artifacts/before-voice-mastering-20261103/recordings/`
to recover the original decoded audio.

The shared profile also softens entrances and endings: voice/humming use 120 ms
fade-ins and up to 200 ms fade-outs; impacts use 20 ms / 40 ms. Fades follow
the audible region, including recordings with leading silence, and shorten for
very brief sounds. No silence is trimmed and file durations stay unchanged.
Active-region RMS matching only attenuates unusually loud recordings (targets
-26 dBFS for voice and -24 dBFS for impacts, at most 12 dB extra attenuation),
with a -9 dBFS peak ceiling. Quiet takes are not boosted. Idle playback receives
another -6 dB through both Web Audio and the plain audio fallback. Direct
reactions keep their existing playback volume. The prior masters are preserved
in `artifacts/before-soft-audio-entrances-20261103/`.

Playback now shuffles imported reaction and spoken pools, using each take before
reshuffling and avoiding repeated takes at bag boundaries. Aliased pools (such
as laugh/giggle) share selection history. Impacts use the same shuffle policy
and preload when the audio module installs or effects are enabled.

Idle sounds receive another -4 dB in silence compared with media playback.
Spontaneous reactions pause during typing (five seconds after the latest key)
and busy work, with at least ten seconds between starts, six seconds after a clip ends and
a maximum of three spontaneous starts per rolling minute. Direct
reactions use a short 450 ms spacing; impact contact timing is unchanged.

Reaction and spoken audio fade out over 80 ms when interrupted. Reaction fades
use a gain ramp with Web Audio and stepped volume otherwise. Mute and hidden
pages still stop immediately; outstanding fade timers cannot affect newer audio.

The spam audit adds 110 ms impact burst deduplication, at most two active
impact tails, and a 250 ms expiry for pending impact/fallback decoding.
Delayed effects are dropped rather than queued. Voice phase events share a
two-second gap and an eight-second per-phase cooldown, and never restart over
current speech. Treat audio also cannot restart current speech. Older synthesized
effects have a 180 ms global gap and per-kind cooldowns; muted/hidden states
cancel pending impacts and stop their active sources.
Regression coverage: `tests/check_hq_companion_audio_spam.mjs`.

The reaction player reuses the project audio context when available. Completion,
error, rejected playback and interrupted playback all disconnect their Web Audio
nodes, remove media handlers, release the media source and clear fade timers.
`tests/check_hq_companion_audio_resources.mjs` stress-checks 2,000 lifecycle
cycles and rejected playback. Only the three impacts are predecoded (about
0.54 MiB of sample buffers); the remaining recordings load on demand.
These are resource/lifecycle checks, not a live browser frame-rate measurement.
