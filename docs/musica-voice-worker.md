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

## Text jobs: a small LLM on the same GPU (opt-in)

The worker can also answer short text for HQ with a small local model (llama.cpp `llama-server`, Gemma 3 4B Q4_K_M,
4096-token window). It saves the Gemini/NIM quotas; it does not take load off the main PC's GPU.

- **Sharing the GPU.** `llama-server` runs with `--fit on -fitt 3300`: llama.cpp places the layers itself and leaves
  ~3.3 GB of VRAM for Chatterbox (override with `--llm-args`). Measured on the RTX 2060 with the model loaded, a Chatterbox
  sentence took 3.8-4.4 s against 4.1 s without it. A model too big to share (Qwen 7B on the GPU alone evicts Chatterbox)
  needs `--llm-exclusive`: the worker then stops the LLM the moment a sentence arrives.
- **Voice always wins.** The worker does one job at a time and claims a sentence before a text job. HQ sends no text job while
  a sentence is queued or was asked for in the last 5 s. The worker starts `llama-server` on the first text job and stops it
  after 5 idle minutes.
- **When HQ asks it** (`hq_ai.generate`: ambient or background calls, and assistant chip visits; never adult mode, search,
  images, streaming or Transferania chat; JSON only for chip visits; prompts up to 2800 tokens). Only in two cases: (1) **fallback**: every Gemini/Gemma model of the chain
  on every key failed, and the laptop is tried before NVIDIA NIM; (2) **low quota**: every model of the chain is within 10 %
  of its daily request limit (or in back-off) on every key, or the ambient daily budget is within 10 % of spent, or no key
  is set. The laptop then goes first so the last Gemini calls are kept for chat. With quota left Gemini always answers first.
  A chip visit asks for JSON: the worker passes `response_format: json_object` to llama-server (valid JSON by construction),
  HQ re-checks it parses, and the visit code still applies its own voice checks, then its NVIDIA fallback. A visit also counts
  as "low" when its own daily budget is within 10 % of spent.
  When the laptop is offline, busy, slow (25 s) or its text breaker is open (2 failures, 2 minutes), nothing changes. A reply
  carries the model name `local-gemma-3-4b`; ambient quota counters do not move.
- **Turn it on:** `"local_llm": true` in `bridge_config.json` and restart the bridge. On the worker add
  `--llm-server <llama-server.exe> --llm-model <file.gguf>` to `run` (`C:\TransfertWorker
un-voice-worker.cmd`); it then
  advertises `llm` and HQ's status shows `llm`, `text_done`, `text_breaker_open`. Without those options nothing changes.
- A job carries messages, a temperature and a token cap (400 max), never a path or a command. `llama-server` listens on
  127.0.0.1 only.
- Measured on the RTX 2060 beside Chatterbox: Gemma 3 4B ~22 tokens/s (1.5-3 s for a short reply); Qwen 2.5 7B 5-8 tokens/s; Gemma 4 E4B 12-14 tokens/s.

### Accueil greeting bank (opt-in, off by default)

`"home_greetings": true` (with `local_llm`) lets `GET /api/home-greetings` start a background top-up of `hq_greetings.json`:
10 short French lines per moment of the day (`hq_greetings.py`), written by the laptop's model in JSON mode with the built-in
lines of `assets/hq-home.js` as style examples, then kept only if they pass a strict filter (2-5 words, at most 28 characters,
French letters only, no full stop, digits, emoji, formal address or English words). It never uses Gemini and never runs on
page load; at most one attempt per 30 minutes, and it stops at the first call the laptop cannot answer. The page keeps a copy in
`localStorage` (`hq_greet_bank`), mixes those lines with its built-in ones, and keeps its pick for the whole day and moment
(`hq_greet_pick`), so the line never rewrites itself. With the flag off the file stays empty and nothing changes.
**Off by default because Gemma 3 4B's lines were weaker than the hand-written ones** (28 of 80 survived the filter on the first
real run; vague, question-heavy). Try it with `home_greetings` on and read what lands in `hq_greetings.json` before keeping it.

### Carnet "by meaning" (opt-in `carnet_semantic`)

Two background jobs on the worker, separate from Ask Carnet (which stays evidence-only: no model, no embeddings, tests pin it):

- **Suggestions by meaning** (`hq_carnet_semantic.py`, `GET /api/carnet-semantic?q=…`). EmbeddingGemma 300M (Q8, 768 dims, **CPU
  only**, a few hundred MB of RAM, started on demand, stopped after 15 idle minutes) turns each canonical text block into a
  vector, kept in `hq_carnet_semantic.json` (a text hash and a half-precision vector per block). A query returns blocks whose
  meaning is close (French/English, synonyms), each with its **current** canonical text read from the live page, a score, and the
  `#carnet/<page>/<block>` link. Suggestions are labelled as not being proof. Cut-off 0.30: on a real run relevant queries
  scored 0.36-0.62 and unrelated ones 0.10-0.20. An edited block is stale until re-embedded and is never shown. Bounded: 64
  blocks per run, 8 per call, 600 characters per block, 5 minutes between runs.
- **Page digests** (`hq_carnet_digest.py`). The small LLM writes a 1-2 sentence summary and 3-5 tags per page (3 pages per run,
  about 4 s each), in the note's language, with the note passed as data between `<note>` tags. Kept in `hq_carnet_digests.json`
  with the hash of the text they came from; an edited page's digest is hidden until rewritten. Generated text, shown as such,
  never written into a page.
- **Rules:** the notebook is only read (`hq_carnet_review.live_pages`); only the local worker is used, never Gemini; embed jobs
  carry texts only, and a sentence is always claimed before them (`EMBED_QUIET` 2 s for the owner's query, `TEXT_QUIET` for
  indexing). Without the flag nothing is read, sent or written, and the Ask dialog is unchanged. The UI is
  `assets/hq-carnet-semantic.js`: it adds a section under the Ask dialog only when the route says the feature is on.
- **Turn it on:** `"carnet_semantic": true`, plus `--embed-model <embeddinggemma .gguf>` on the worker's `run` (the same
  `--llm-server` binary). Opening Carnet starts the first indexing in the background.

## What to measure first

The RTX 2060 has 6 GB: check peak VRAM and the real-time factor on the worker (see the setup log in
`C:\AI\Chatterbox\SETUP-LOG.md`). If a sentence regularly takes more than a few seconds, HQ's 45 s cap and the
breaker keep the show running on the fallback, but the live drops would be better served by the local daemon.

State: `.hq-music/voice-worker.json` (hash and name only). Tests: `tests/test_hq_voice_remote.py`.
