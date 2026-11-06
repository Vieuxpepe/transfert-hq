# HQ API error codes (agents)

Stable **`code`** fields in JSON error bodies and in **`server_errors`** / **`errors.jsonl`**.  
Prefer **`agent_triage.error_code_hints`** and **`request_id_index`** in **`GET /api/diag/agent-brief`** over reading this whole file.

4xx codes are usually **normal refusals** (not recorded in `errors.jsonl`). This doc focuses on codes agents see in **5xx** and **`server_errors`**.

---

## Carnet / storage

| Code | Typical HTTP | Agent hint |
|------|--------------|------------|
| `storage_error` | 503 | Notebook or media path refused — check readiness `carnet_read`, disk space, `.hq-carnet` permissions |
| `transcribe_failed` | 503 | Voice note transcription failed |
| `notebook_revision_conflict` | 409 | Notebook rev changed elsewhere — refresh Carnet |
| `revision_conflict` | 409 | Write conflict on Carnet mutation |
| `stale_selection` | 409 | UI selection no longer matches notebook |
| `export_exists` | 409 | Export filename collision |
| `request_result_gone` | 409 | Idempotent replay after delete |

## Validation / client

| Code | Typical HTTP | Agent hint |
|------|--------------|------------|
| `validation_error` | 400 | Body or query failed validation — do not grep message text; fix payload shape |
| `validation` | 400 | Forge vault validation |
| `bad_triage` | 400 | Inbox tri state invalid |
| `bad_length` | 411 | Upload without usable Content-Length |

## Forge / companion art

| Code | Typical HTTP | Agent hint |
|------|--------------|------------|
| `forbidden` | 403 | Role or policy blocked action |
| `nsfw_off` | 403 | NSFW disabled in config |
| `forge_error` | 500 | Companion/forge art handler fault |
| `no_favorite` | 400 | Missing favorite look for action |
| `deprecated` | 410 | Route/action retired |

## Reader / diagnostics

| Code | Typical HTTP | Agent hint |
|------|--------------|------------|
| `reader_unknown` | 404 | PDF reader route unavailable |
| `diagnostic_failed` | 500 | `/api/diag/*` internal error — not the same as Carnet 500 |

## Generic (recorded on 5xx without fixed code)

| Code | Agent hint |
|------|------------|
| `http_500` | Unclassified server exception — use `path_category`, `type`, `request_id` |
| `http_503` | Structured refusal — pair with readiness and subsystem |

---

When adding a **new stable code** in handlers, add one row here and optionally one line in **`ERROR_CODE_AGENT_HINTS`** in `hq_diagnostics.py` so **`error_code_hints`** stays useful.

See also: **[hq-symptom-index.md](hq-symptom-index.md)** · **[agent-debugging.md](agent-debugging.md)**.
