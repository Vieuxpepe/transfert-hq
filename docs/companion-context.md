# Companion context hygiene

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
Static. Do not invent private sister chats behind the Master's back, and never
merge their memory stores. Master-triggered sister dialogue and rare ambient
sister banter on an open HQ are allowed: each turn stays in that sister's own
voice and log.
<!-- ELSE_TRANSFERANIA_FAMILY_CANON:END -->


Defaults need no migration. Add optional settings under `companion_context` in
`bridge_config.json`, then restart the bridge:

```json
{
  "companion_context": {
    "chat_input_budget": 24000,
    "ambient_input_budget": 5000,
    "ambient_daily_limit": 240,
    "chat_daily_limit": 1000,
    "model_input_tpm": {
      "gemma-4-26b-a4b-it": 16000,
      "gemma-4-31b-it": 16000,
      "gemini-3.1-flash-lite": 250000,
      "gemini-3.5-flash-lite": 250000,
      "gemini-3.6-flash": 250000
    }
  }
}
```

The input budget uses **UTF-8 bytes plus request overhead** as a conservative
local token estimate. It is deliberately larger than typical provider token
counts; it is not a tokenizer and never makes a counting API call. Output caps
are separate.

**Per-model caps.** `chat_input_budget` is the ceiling; each model gets
`model_input_cap` = the smaller of that budget and 85 % of its per-minute token
allowance, converted to bytes. Defaults assume Flash Lite as the usual chat
answerer (`24000` / ambient `5000`). Gemini Flash Lite (250K TPM) takes the full
configured budget; Gemma (16K TPM) receives a re-fitted prompt with the same
priorities when its cap is smaller. Summaries trigger at the smallest cap in the
chain, so a fallback model still has the summary.

**Calibration.** Google meters tokens, HQ counts bytes. Every successful call
records `estimate / promptTokenCount` in `.hq-ai/token-calibration.json` (last
100 per family, Gemma and Gemini separately; prompts under 1 500 bytes and
ratios outside 2–5 are ignored). The ratio used is the 10th percentile minus
5 %, or 3.0 bytes/token until a family has 10 samples. It converts the per-model
caps and the per-minute reservations; budgets stay in bytes. HQ's French
prompts measured 3.57–3.77 bytes/token, which lifts Gemma's cap from 13.6 KB to
about 48 KB. A missing or damaged file falls back to the default.

Instructions and the current message are preserved. A request
that cannot fit those essentials fails with `context_budget` before generation.

Selection protects corrections, real events and current behavior before spending
space on memories, summaries and whole paired history. The latest two exchanges
anchor continuity; older pairs need lexical relevance to the current request.
Page/context blocks precede optional cadence and character habits. Sections that
do not fit are omitted whole, with reasons in the inspector. See
[`companion-prompt-assembly.md`](companion-prompt-assembly.md) for exact ownership,
priorities, summary behavior, trace privacy and repeatable evaluations.
Storage is independent: prompt trimming and summarization never delete source
messages. Existing history responses retain their established display limits.
Old messages previously deleted by the old compressor cannot be recovered.

Summary refresh requires an overflowing conversation and eight new complete
exchanges. The latest four exchanges stay outside the summary. At most one
model summary is attempted per device every 15 minutes, with a deterministic
decision/reason/open-thread fallback. Previously summarized source exchanges
remain available for relevant retrieval. Summary calls and failed provider attempts consume daily quotas.
Each generation tries at most two available providers.

## Model routing and rate limits

Short ambient and background jobs (up to 4,000 estimated input units) prefer
Gemma 4 26B; larger jobs prefer Flash Lite. Normal conversation keeps its Flash
Lite primary. Routing only reorders existing eligible models; it does not add
unverified API model IDs or activate models with zero quota.

Every `hq_ai.generate` call, including HQ questions, summaries and memory jobs,
shares a per-model rolling 60-second input TPM pool. Before network I/O, an
atomic reservation checks RPM, RPD, TPM and the applicable local daily cap.
Reservations use the same conservative byte estimate as context selection.
Measured `promptTokenCount` replaces the estimate when returned; missing usage
retains the estimate for the rest of the window. Output caps are separate from
Google's input TPM limit. Unavailable models are skipped without using an attempt.
There is no automatic truncation to squeeze a request into Gemma.

Reservations and a 60-second backoff after HTTP 429 persist in `usage.json`
across bridge restarts. Provider daily request counts reset on the Pacific date;
the companion's own daily caps reset on the bridge's local date. Rolling windows
survive both resets. Limits are project-wide at Google: traffic from other apps
using the same project cannot be measured here, so local scheduling cannot
guarantee that Google will accept a request.

Admission is serialized across threads **and processes** using a bounded file
lock. Quota writes use unique temporary files, flush/fsync, and atomic replacement
before a provider call is permitted. The process lock is released before network
I/O. A corrupt, inaccessible, oversized, or unexpectedly missing known ledger
blocks calls instead of silently resetting the quota. Restore a valid ledger
without reducing counters to repair it; deleting it is not a recovery procedure.
Backward clock changes retain reservations and daily counters conservatively.

The in-memory usage cache stores independent snapshots and invalidates on file
identity, size or modification-time changes. Successful quota writes refresh it;
other processes' writes trigger validation on the next read. Context selection
accounts for whole sections incrementally, and summary pressure checks stop once
the budget is exceeded. The outgoing companion payload is checked again at the
send boundary. Non-text payloads are rejected until a metering policy exists for
them. Malformed provider token counts never release reserved capacity.

Default local caps are now 240 ambient attempts and 1,000 chat/background memory
attempts per day. Summary attempts count against the latter. Zero disables that
category; invalid values use the defaults. Changing a limit does not reset usage.
The existing ambient cooldowns remain in force even with a higher daily cap.
`model_input_tpm` overrides let you follow changes in the project's AI Studio
dashboard without altering code. The model status endpoint adds `per_minute`,
`input_tpm`, `input_tokens_reserved_last_minute`, `requests_last_minute`, and
`backoff_seconds`; existing fields remain compatible.

Ambient requests return `skipped`, `reason: coalescing`, and `retry_after` during
an eight-second window. The frontend retries once; the server uses the latest
pending context. Generated ambient requests have a two-minute cooldown and
identical payloads are suppressed for five minutes. Skipped requests do not
clear the current dialogue or consume pending UI events. Chat is immediate;
overlapping chat returns retryable HTTP 409 `companion_busy`. Background memory
extraction skips an occupied device. Different devices remain independent.

Successful/fallback companion responses include `context_usage`: estimated
input size, budget, selected memory count, omitted history count, provider
attempts, summary calls, latency, measured usage when returned, and cost status.
It also includes aggregate selection counts. Detailed content-free manifests
are available only through the explicit read-only context inspector, capped at
200 rows; they are not returned in routine responses or written to usage logs.
The local `.hq-ai/context-usage.json` log keeps at most 500 metadata records.
It contains no prompts, messages, memory text, device IDs, or credentials.

Cost is unavailable unless `prices_per_million` is configured inside
`companion_context`, mapping exact model IDs to numeric `input` and `output`
rates in a single chosen currency. These are operator-supplied estimates, not
prices fetched from a provider. A total is reported only when all attempts have
the measured usage and configured rates needed to estimate it. Provider billing
may treat cached or reasoning tokens differently; no billing accuracy is claimed.

Verification:

```powershell
python -m pytest tests/test_hq_ai.py tests/test_hq_life.py tests/test_hq_companion_context.py tests/test_hq_model_routing.py tests/test_hq_budget_integrity.py -q
node --check assets/hq-companion.js
```


### Reading full replies
The floating preview shows up to four lines and exposes **Lire la suite** only
when it overflows. This opens the corresponding full message in the conversation;
page remarks are retained for that reading session without writing chat history.
Desktop reserves space for the avatar. On phones the conversation is a viewport
sheet sized on visualViewport resize, including the keyboard. The composer stays
outside the scrolling log. Text in the log is selectable. New text follows the
bottom only when the reader was already there; otherwise **Nouveau message ↓**
returns to the newest text. Dragging remains on the existing bubble edges.
Chat replies retain all generated text rather than slicing at 900/1200 characters.
Generation token budgets still apply. Registers encourage concise replies and
permit occasional natural emojis; they do not require emojis on every reply.
