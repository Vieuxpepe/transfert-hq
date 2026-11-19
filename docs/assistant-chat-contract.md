# Assistant chat contract

What the six HQ assistants' chat pipelines are held to, after the 2026-11-14
audit. Each row of the table at the end is the **current** state, including the
gaps that were deliberately not closed yet — this page is a contract for new
work, not a claim that every module already meets all of it.

Modules: Culinia (`hq_culinia`), Forgia (`hq_forgia`), Musica (`hq_musica`),
Inventoria (`hq_inventoria` + `hq_inventoria_ai`), Pistonia (`hq_pistonia` +
`hq_engine` routes), Securia (`hq_securia`).

## 1. Thread state

**JSON-state assistants** (Culinia, Forgia, Securia) keep
`.hq-household/culinia_thread.json`, `.hq-forge/forgia_thread.json`,
`.hq-security/securia_thread.json` in the shape:

```json
{"messages": [...], "revision": 3, "clear_epoch": 1}
```

- Written through `hq_state.write_json_atomic` (lock, `.tmp`, fsync,
  `os.replace`). A file that exists but does not parse is **never replaced**:
  the API answers `409 state_unreadable` and the bytes stay on disk.
- `clear_thread()` replaces the list and advances **both** `revision` and
  `clear_epoch`.
- A finished turn is stored with `append_turn_if_current(turn, revision, epoch)`:
  - `False` because another turn landed → re-read and **rebase**: the newer
    turn is kept and this one is appended after it (never a replay of tool
    calls that already ran).
  - `False` because the epoch moved (cleared) → the reply is **dropped** and the
    response carries `cancelled: true`; the chip renders the stored thread, not
    the late answer.

**Inventoria** stores turns in SQLite (`inventoria_sessions.messages_json`,
`rev`). The chat write is optimistic: inside `_session_write_lock` the row is
re-read, and if `rev` moved, the messages that landed meanwhile are kept and
this turn is appended (`rev` is also the `WHERE` precondition).

**Pistonia** stores through `hq_pistonia_store.add_message` after the turn, so
its cancel path returns before anything is written.

## 2. Cancellation (Arrêter)

- The browser sends a job id matching `^[a-z0-9][a-z0-9-]{5,39}$` with the
  message. The server records it for 180 s (`CANCEL_TTL`).
- The loop checks the flag **before every model round and every tool call**;
  a cancelled turn stores nothing and answers `{ok: true, cancelled: true,
  messages: <stored thread>}`.
- Routes: `POST /api/culinia/cancel`, `/api/forgia/cancel`,
  `/api/securia/cancel`, `/api/inventoria/cancel`, `/api/musica/cancel` — all
  body `{job}` — and `POST /api/engine/pistonia/cancel` `{job}`. All admin + CSRF.
- A single in-flight model call cannot be interrupted; the stop lands at the
  next round, which is why the chip keeps the pending row until the response
  arrives.
- **Gap:** Musica's turn holds the module `_lock` for its whole length, so
  `/clear` and status writes queue behind it. The cancel route lets the chip stop
  the turn, but the lock itself is unchanged (releasing it safely means copying
  `ThreadReferences` state and is a separate refactor).

## 3. Tools and side effects

- Read-only tools run inside the turn and count against the module's
  `MAX_TOTAL_TOOLS` / `MAX_ROUNDS`.
- Anything that changes real state is **proposed, never executed from the
  model's turn**:
  - Securia – `MUTATING_TOOLS` (`block_ip`, `unblock_ip`, `rearm_tripwire`,
    `revoke_session`) become a card stored on the assistant message; only
    `POST /api/securia/confirm {id}` runs it, once (`status` goes
    `pending → running → done|failed`; a second confirm answers
    `409 already_resolved`). `POST /api/securia/dismiss {id}` drops it.
    `block_ip` refuses invalid addresses, loopback, unspecified and link-local
    regardless of what the model asks.
  - Pistonia – `propose_action` / `propose_autostop` cards with Appliquer/Undo.
  - Inventoria – drafts only, then validate → preview → commit (idempotency key,
    undo journal).
  - Musica – destructive tools need a 600 s single-use token
    (`POST /api/musica/confirm`).
  - **Accepted exception:** Culinia writes recipe/calendar/grocery rows directly
    (reversible household data).
- Secrets never reach a prompt or a reply: project-file reads redact key/value
  pairs (Securia), notes refuse secrets (Inventoria, Pistonia).

## 4. Context sent to the model

| Module | Turns sent | Per-message cap | Older-turn digest | Durable memory |
|---|---|---|---|---|
| Pistonia | 12 + 40 digest | 700 (last answer whole) | yes, 40 × 200 | notes 30 × 200, alerts 30, settings |
| Inventoria | 12 | 700 | no | notes 30 × 200 |
| Musica | 12 | 4000 + evidence | no | taste, play history 200, listening journal |
| Culinia | 16 | none (MAX_MESSAGE 4000 on input) | no | preferences (likes, dislikes, equipment, diet) |
| Forgia | 16 | none | no | preferences (styles, checkpoints, negatives, notes) |
| Securia | 16 | none | no | **none** (growth/personhood only) |

Thread retention: 40 messages (Culinia, Forgia, Musica, Securia), 60 (Pistonia),
100 per session (Inventoria).

## 5. Reply contention

Culinia and Forgia answer a merged conversation: up to
`DEFAULT_REPLY_ATTEMPTS` (3) append attempts, one regeneration when another turn
landed (keeping the tool results already obtained), then a `fallback_append`.
Securia appends once and rebases without regenerating (fewer rounds, cheaper
model).

## 6. Checklist for a new assistant

1. Thread state through `hq_state` for JSON, `rev` precondition for SQLite.
2. `revision` + `clear_epoch`; `append_turn_if_current` + rebase; drop on clear.
3. A job id and a `cancel` route; checks before each round and tool call.
4. Every state-changing tool behind a confirmation card or a draft pipeline.
5. A bounded loop (rounds + tool budget + per-result cap) and a tests row in
   `docs/test-index.md`.
6. Roster wiring (Elsea, 2026-11-15, is the latest example): an entry in
   `hq_personas.ASSISTANTS`; her key in `hq_personhood` (`DOMAIN_KEYS`, `VALUES`,
   `AXES`, `_domain_paths`), `assets/hq-personhood.js`, `assets/hq-assistant-sfx.js`
   and `tests/hq_assistant_state.py`; a row in `tests/test_hq_personas_contract.py`.
   Visits: her key in `hq_assistant_visits` (`KEYS`, `VISIT_VOICE`, `VOICE_MAX_WORDS`,
   `VOICE_SAMPLES`, `_paths`, `PLACE_LABELS`), a chip bank plus a pair bank with every
   other chip (and theirs for her) in `assets/hq-assistant-visits.js`, her idle motion in
   `assets/hq-assistant-visits.css`, and the roster/word limit in
   `tests/check_hq_assistant_visits_focus.mjs`. Adding a domain assistant also grows the
   house's family pairs (`FAMILY_KEYS`): update `tests/test_hq_family_state.py`.

## 7. Not done yet (explicit)

- Musica: no digest; a running turn holds the module `_lock`, so `/clear`
  waits for it (the cancel route stops the turn, it does not free the lock).
- Forgia: read-only by design — no digest, no notes memory, no image results.
- Securia: no preference/notes memory; one append attempt (no regeneration).
- Inventoria: no digest of older turns; a cancelled turn is stopped between
  rounds only.
- No shared streaming layer: Pistonia streams (`.../stream`), the other five
  return the finished reply in one JSON body.
