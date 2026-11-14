# Musica voice worker (Chatterbox on another PC)

Musica's expressive English voice is Chatterbox, which needs a GPU. This lets a second Windows PC with an NVIDIA GPU
(for example the RTX 2060 laptop) do that work, so the main PC's GPU stays free. HQ keeps everything else: sentence
joining, mastering, the voice cache and the drops are produced on HQ exactly as before.

## How it works

- `hq_voice_worker.py` runs on the worker and only **polls HQ outbound** (Tailscale). HQ never connects to it, nothing
  listens on a network port there, and the Chatterbox daemon stays on `127.0.0.1`.
- One job is one sentence-sized synthesis. `hq_voice_chatterbox._generate` asks `hq_voice_remote.generate` first; on
  failure or timeout (45 s max per sentence) it tries the local daemon if there is one, then the caller falls back to
  Phonon as before. After two failures the worker is skipped for 60 s (circuit breaker), so a dead laptop costs one slow
  line, not every line.
- With a worker online HQ never starts the local Chatterbox daemon, so this PC's GPU is left alone.
  `voice_engine_for` reports `chatterbox` while a worker is online (French and guests stay on Phonon, as before).
- The reference clip stays owned by HQ (`<Chatterbox root>\voices\musica.wav`, or made from Phonon); the worker
  fetches it by **name** when its stamp changes. A job never carries a path or a command.

## Security

- One worker. Pairing with a one-time code (12 characters, valid 10 minutes, shown once, stored as a SHA-256), at most
  6 attempts per IP per 10 minutes.
- The worker then holds a random token; HQ stores only its hash (constant-time compare). Every worker route needs the
  bearer token; no cookie is read and there is no CSRF. Traffic is Tailscale (WireGuard) plus Tailscale Serve's TLS.
  Unlike the Forge workers there is no per-request HMAC, so a captured request could be replayed: keep HQ reachable only
  over Tailscale.
- The worker's credentials are in `%LOCALAPPDATA%\TransfertHQ\voice-worker.json` (inheritance removed).
- `Retirer` in HQ revokes the token at once; the worker then stops with « Identifiants refusés ».

## Set up

1. On the worker: Chatterbox installed in `C:\AI\Chatterbox` (venv, GPU verified) and a copy of
   `scripts/chatterbox_daemon.py` from the HQ repo. Copy `hq_voice_worker.py` to `C:\TransfertWorker\`.
2. In HQ: Musique › Lecture › DJ Musica › Réglages › **Voix sur un autre PC** › *Créer un code d'association*.
3. On the worker:

   ```powershell
   cd C:\TransfertWorker
   py -3 .\hq_voice_worker.py pair --hq https://<hq>.<tailnet>.ts.net --name "Portable RTX 2060"
   py -3 .\hq_voice_worker.py run --root C:\AI\Chatterbox `
       --daemon-python C:\AI\Chatterbox\venv\Scripts\python.exe --daemon-script C:\TransfertWorker\chatterbox_daemon.py
   ```

   `run` starts the daemon itself when it is not answering. `status` shows the pairing, the daemon and the GPU.
4. HQ shows the device online with its GPU and the time of the last sentence. Start at logon with a scheduled task, as for
   the Forge worker (`docs/forge-workers.md`).

## What to measure first

The RTX 2060 has 6 GB: check peak VRAM and the real-time factor on the worker (see the setup log in
`C:\AI\Chatterbox\SETUP-LOG.md`). If a sentence regularly takes more than a few seconds, HQ's 45 s cap and the
breaker keep the show running on the fallback, but the live drops would be better served by the local daemon.

State: `.hq-music/voice-worker.json` (hash and name only). Tests: `tests/test_hq_voice_remote.py`.
