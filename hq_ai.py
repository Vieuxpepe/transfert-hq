"""Transfert HQ — the assistant (Gemini / Gemma). Stdlib only.

Two jobs:
  « Demander »  a question about your own things. HQ gathers what is relevant (calendar, projects and tasks, Inventaire,
                Carnet pages, file names) from the local stores, sends that short context with the question, and returns the
                answer with numbered sources that link back into HQ.
  « Noter »     one sentence becomes up to three proposed actions (event, task, project « Où j'en suis » note, stock
                change or new item, Carnet note). Nothing is written until you confirm; then each action goes through the
                same validation as the page it belongs to (hq_calendar.save_event, hq_projects.apply, hq_inventory.apply,
                hq_carnet.mutate).
  Transferania  floating companion (``ambient`` + ``transferania`` chat). Mémoire **par appareil** :
                ``.hq-ai/threads/{device_id}.json`` et ``.hq-ai/prefs/{device_id}.json`` (archive conservée, contexte borné).
  Compagnon     alias persona warm/flirt/off; local daily caps configurable (ambient 240, chat/background 1000).

The API key lives only in bridge_config.json (``gemini_api_key``) on this PC and is sent only to Google in a header,
never to the browser. Models are tried in order and skipped when they are busy (429/503) or when HQ's own count says the
day's free quota is used (``.hq-ai/usage.json``, per model, per local day, plus a per-minute window). Admin only.
"""

from __future__ import annotations

import json
import functools
import hashlib
import math
import uuid
import copy
from contextlib import contextmanager
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import hq_life
import hq_pronunciation
import hq_companion_memory as companion_memory
import hq_companion_presence as companion_presence
import hq_companion_context as companion_context
import hq_companion_archive as companion_archive
import hq_else_persona as _else_persona
from pathlib import Path
from typing import Any, Callable

hq_pronunciation.warmup()

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# (model id, label, requests per minute, requests per day) — the free tier of this key
MODELS = {
    "gemini-3.1-flash-lite": ("Gemini 3.1 Flash Lite", 15, 500),
    "gemini-3.5-flash-lite": ("Gemini 3.5 Flash Lite", 15, 500),
    "gemini-3.6-flash": ("Gemini 3.6 Flash", 5, 20),
    "gemma-4-26b-a4b-it": ("Gemma 4 26B", 30, 14400),
    "gemma-4-31b-it": ("Gemma 4 31B", 30, 14400),
}
# Input TPM from the project's AI Studio limits; independent of request quotas.
MODEL_TPM = {m: (16000 if m.startswith("gemma-") else 250000) for m in MODELS}
ASK_CHAIN = ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it")
DEEP_CHAIN = ("gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite")
CAPTURE_CHAIN = ("gemma-4-26b-a4b-it", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it")
AMBIENT_CHAIN = ("gemini-3.1-flash-lite", "gemma-4-26b-a4b-it", "gemini-3.5-flash-lite")
# Adult mode: Flash Lite first, as in the Else project (same BLOCK_NONE settings; its 2026-09-14 probe found
# Gemma's 16k free TPM caused 429s and Flash Lite won on availability and quality). Gemma is the second
# attempt, so a reply Gemini stops early (SAFETY / truncated) is retried on a different model family.
# Gemma 31B is last: it failed ~86% of its calls (HTTP 500 or transport) in the Nov 2–3 logs.
# 3.5 Flash Lite leads: on 2026-11-03, 3.1 Flash Lite gave "high demand" 503s and 45 s timeouts on both keys
# while 3.5 answered in about a second.
NSFW_CHAIN = ("gemini-3.5-flash-lite", "gemma-4-26b-a4b-it", "gemini-3.1-flash-lite", "gemma-4-31b-it")
# Normal (non-adult) chat: 3.5 Flash Lite first (the AMBIENT_CHAIN head gave 503s / 45 s timeouts), then the
# ambient models as fallbacks. Ambient/background keep AMBIENT_CHAIN and adult chat keeps NSFW_CHAIN.
CHAT_LEAD_MODEL = "gemini-3.5-flash-lite"
CHAT_CHAIN = tuple(dict.fromkeys((CHAT_LEAD_MODEL,) + AMBIENT_CHAIN))
CHAT_DEADLINE_S = 40.0        # whole normal chat request, server side (the browser gives up at 45 s)
CHAT_MIN_ATTEMPT_S = 12.0     # never start a model attempt with less than this left before the deadline
CHAT_MIN_TIMEOUT_S = 8        # floor of the per-attempt timeout under a deadline
CHAT_SUMMARY_WINDOW_S = 20.0  # the in-request summary model call must fit in the first 20 s
THREAD_UNREADABLE_MSG = "Historique illisible - copie conservée, réessaie après restauration"
STORE = ".hq-ai"
USAGE = "usage.json"
Q_MAX = 2000
AMBIENT_DAILY = 240
TRANSFERANIA_DAILY = 1000
TRANSFERANIA_FILE = "transferania.json"
TRANSFERANIA_PREFS_FILE = "transferania_prefs.json"
TRANSFERANIA_THREADS = "threads"
TRANSFERANIA_PREFS_DIR = "prefs"
DEVICE_ID_MIN = 12
DEVICE_ID_MAX = 48
TRANSFERANIA_KEEP = 20
TRANSFERANIA_KEEP_NSFW = 100
TRANSFERANIA_MSG_MAX = 1600
TRANSFERANIA_SUMMARY_MAX = 1400
TRANSFERANIA_NAME = "Transferania"
ELSE_NAME = "Else"
ELSE_THREADS = "threads_else"
COMPANION_CHAT_PHOTOS_SUB = Path("assets") / "companion" / "chat"
COMPANION_LOOPS_SUB = Path("assets") / "companion" / "loops"
_PHOTO_ID_RE = re.compile(r"^[a-z0-9_-]{1,48}$")
_PHOTO_TAG_RE = re.compile(r"\[photo:([a-z0-9_-]{1,48})\][\s.,;:!?\u2026]*$", re.I)
_LOOP_TAG_RE = re.compile(r"\[loop:([a-z0-9_-]{1,48})\][\s.,;:!?\u2026]*$", re.I)
_FX_TAG_RE = re.compile(r"\[fx:([a-z0-9_-]{1,24})\][\s.,;:!?\u2026]*$", re.I)
# Any media tag syntax, anywhere: stripped from shown/spoken text (only the trailing tags above are acted on).
_ANY_MEDIA_TAG_RE = re.compile(r"[ \t]*\[(?:photo|loop|fx):[a-z0-9_-]{1,48}\]", re.I)
COMPANION_FX_ALLOWED = frozenset({"kiss", "flash", "bounce", "steam", "burst"})
COMPANION_PHOTO_MOOD: dict[str, str] = {
    "neutral": "portrait calme",
    "soft": "douceur, afterglow",
    "warm": "complice chaude",
    "celebrate": "joie, victoire",
    "tender": "réconfort",
    "bed-prone": "allongée, vue prone",
    "all-fours": "à quatre pattes, angle bas",
    "all-fours-side": "profil strict, dos cambré",
    "all-fours-broom": "profil très lewd, micro-ficelles",
    "booty-arch-mirror": "cambrée devant le miroir, reflet double",
    "cowgirl-straddle": "à califourchon sur toi, vue plongeante POV",
    "doggystyle-lookback": "à genoux coudes sur le lit, cambrure et regard arrière",
    "against-glass": "corps plaqué contre la vitre embuée",
    "kneeling-collar": "à genoux docile, regard dévot pour son maître",
}
_PHOTO_CHAT_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}
AMBIENT_DIGEST_MAX = 900
AMBIENT_PAGE_MAX = 2200
AMBIENT_LINE_MAX = 280
VIEW_LABELS = {
    "accueil": "Accueil",
    "carnet": "Carnet",
    "calendrier": "Calendrier",
    "dessiner": "Dessiner",
    "forge": "Forge",
    "fichiers": "Fichiers",
    "projets": "Projets",
    "inventaire": "Inventaire",
    "lecteur": "Lecteur",
    "ops": "Terminal",
    "plus": "Système",
}
HISTORY_MAX = 6
CONTEXT_CHARS = 24000
TIMEOUT = 45
KINDS = ("event", "task", "project_note", "stock", "note")
STOP = set("""le la les un une des du de d l au aux et ou en dans sur sous pour par avec sans ce cet cette ces mon ma mes ton ta tes
son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te se y a est sont ai as avons avez ont suis es
etre être fait faire quoi que qui quand comment combien quel quelle quels quelles est-ce ne pas plus moins tout tous toute toutes
bien très tres alors donc mais car si oui non the of and to in is it what where when how my me""".split())

_cb: dict[str, Any] = {}
_lock = threading.RLock()
_minute: dict[str, list[float]] = {}
_companion_local = threading.local()
_companion_active: set[str] = set()
_ambient_pending: dict[str, dict] = {}
_ambient_recent: dict[str, dict] = {}
_usage_cache: dict[str, tuple[tuple, dict]] = {}
_usage_transaction_local = threading.local()


def companion_config() -> dict:
    fn = _cb.get("companion_context_config")
    raw = fn() if callable(fn) else {}
    return raw if isinstance(raw, dict) else {}


def _budget_integer(value: Any, default: int, minimum: int, maximum: int) -> int:
    try:
        if isinstance(value, bool) or (isinstance(value, float) and (not math.isfinite(value) or not value.is_integer())):
            return default
        return max(minimum, min(maximum, int(value)))
    except (ValueError, TypeError, OverflowError):
        return default


def context_budget(channel: str) -> int:
    # Chat defaults assume Flash Lite (250K TPM) as the usual answerer; ambient stays lean for events/time.
    default = 5000 if channel == "ambient" else 24000
    return _budget_integer(companion_config().get(channel + "_input_budget", default), default, 512, 100000)


def estimate_context(system: str, contents: list[dict]) -> int:
    """Conservative local byte estimate, not a provider token count."""
    def _valid_part(p: Any) -> bool:
        if not isinstance(p, dict):
            return False
        if set(p) == {"text"} and isinstance(p["text"], str):
            return True
        if set(p) == {"inlineData"} and isinstance(p["inlineData"], dict) and set(p["inlineData"]) == {"mimeType", "data"} and isinstance(p["inlineData"].get("mimeType"), str) and isinstance(p["inlineData"].get("data"), str):
            return True
        return False

    if any(not isinstance(m, dict) or not isinstance(m.get("parts"), list) or
           any(not _valid_part(p) for p in m["parts"])
           for m in contents):
        raise AiError("Le budget ne prend en charge que les messages texte", 400, "unsupported_context")
    texts = [system] + [str(p.get("text", "")) for m in contents for p in m.get("parts", []) if "text" in p]
    img_overhead = sum(768 for m in contents for p in m.get("parts", []) if "inlineData" in p)
    return 32 + 16 * len(contents) + sum(len(t.encode("utf-8")) for t in texts) + img_overhead


def _dedup_blocks(text: str) -> str:
    seen = set()
    blocks = []
    for block in re.split(r"\n\s*\n", str(text or "")):
        key = re.sub(r"\s+", " ", block).strip()
        if key and key not in seen:
            seen.add(key)
            blocks.append(block.strip())
    return "\n\n".join(blocks)


def relevant_memories(data: dict, query: str) -> list[str]:
    query_words = set(words(query))
    ranked = []
    seen = set()
    for index, fact in enumerate(data.get("facts") or []):
        text = str(fact.get("text", "") if isinstance(fact, dict) else fact).strip()
        key = fold(text)
        overlap = len(set(words(text)) & query_words)
        if text and key not in seen and overlap:
            seen.add(key)
            ranked.append((overlap, index, text))
    return [r[2] for r in sorted(ranked, reverse=True)[:5]]


def complete_exchanges(messages: list[dict]) -> list[list[dict]]:
    groups = []
    pending = None
    for msg in messages:
        if not isinstance(msg, dict) or msg.get("kind") == "ambient":
            continue
        if msg.get("role") == "user":
            pending = msg
        elif msg.get("role") == "assistant" and pending is not None:
            groups.append([pending, msg])
            pending = None
    return groups


def build_companion_context(channel: str, system: str, message: str, *, history: list | None = None,
                            summary: str = "", memories: list | None = None, page: str = "",
                            corrections: list | None = None, budget: int | None = None,
                            record: bool = True) -> tuple[str, list, dict]:
    """Priority selection of whole evidence blocks and paired history; archives stay intact.

    ``budget`` narrows the channel budget for one model (see ``model_input_cap``); ``record=False``
    leaves the request telemetry describing the main assembly."""
    budget = min(context_budget(channel), budget) if budget is not None else context_budget(channel)
    system = _dedup_blocks(system)
    groups = [thread_to_contents(group) for group in complete_exchanges(history or [])]
    try:
        contents, selection = companion_context.assemble(system, message, budget=budget, groups=groups,
            summary=str(summary or "")[:TRANSFERANIA_SUMMARY_MAX], memories=memories or [],
            corrections=corrections or [], page=page)
    except ValueError as error:
        raise AiError("Instructions et message dépassent le budget de contexte configuré", 413, "context_budget") from error
    info = {"estimated_input_tokens": estimate_context(system, contents), "estimate_method": "utf8_bytes_plus_overhead",
            "input_budget": budget, "selected_memory_count": selection["selected_memory_count"],
            "omitted_history_count": max(0, len(history or []) - selection["selected_history_count"]),
            "selection_manifest": selection["selection_manifest"],
            "selection_totals": selection["selection_totals"],
            "manifest_omitted_count": selection["manifest_omitted_count"]}
    if info["estimated_input_tokens"] > budget:
        raise AiError("Contexte assemblé au-delà du budget", 413, "context_budget")
    state = getattr(_companion_local, "state", None) if record else None
    if state is not None:
        # Detailed metadata is for the read-only inspector, not every reply or
        # the on-disk usage log. Aggregates are sufficient for routine traffic.
        state.update({k: v for k, v in info.items() if k != "selection_manifest"})
    return system, contents, info


def _write_context_usage(info: dict) -> None:
    """Metadata only; capped at 500 records and never allowed to break a reply."""
    allowed = {"reason", "estimated_input_tokens", "estimate_method", "input_budget", "selected_memory_count",
               "omitted_history_count", "provider_attempts", "latency_ms", "provider_usage", "cost", "cost_status", "at", "summary_calls",
               "conversation_mode", "continuity_kind", "selected_episode_count", "selection_totals", "manifest_omitted_count"}
    row = {k: v for k, v in info.items() if k in allowed}
    if "selection_totals" in row:
        counts = row["selection_totals"]
        row["selection_totals"] = {k: v for k, v in counts.items()
            if k in {"mandatory", "included", "budget", "duplicate", "irrelevant"} and type(v) is int and v >= 0} if isinstance(counts, dict) else {}
    if "manifest_omitted_count" in row and (type(row["manifest_omitted_count"]) is not int or row["manifest_omitted_count"] < 0):
        row.pop("manifest_omitted_count")
    try:
        with _lock:
            p = Path(_cb["root"]) / STORE / "context-usage.json"
            try:
                rows = json.loads(p.read_text("utf-8"))
                rows = rows if isinstance(rows, list) else []
            except (OSError, ValueError):
                rows = []
            p.parent.mkdir(parents=True, exist_ok=True)
            _atomic_write_text(p, json.dumps((rows + [row])[-500:]))
    except (OSError, KeyError):
        pass


def companion_request(channel: str):
    def decorate(fn):
        @functools.wraps(fn)
        def wrapped(*args, **kwargs):
            did = normalize_device_id(kwargs.get("device_id"))
            now = _now()
            char = str(kwargs.get("character") or "transferania").strip().lower()
            if char not in ("transferania", "else", "sister"):
                char = "transferania"
            root_key = str(_cb.get("root", "")) + ":" + companion_memory.current_owner() + ":" + char + ":" + did
            with _lock:
                if root_key in _companion_active:
                    if channel == "chat":
                        raise AiError("Une réponse est déjà en cours; réessaie dans un instant", 409, "companion_busy")
                    return {"ok": True, "line": "", "skipped": True, "reason": "busy"}
                can_generate_ambient = (channel == "ambient" and bool(_api_keys()) and ambient_ok()
                    and (_resolve_persona(kwargs.get("persona", args[2] if len(args) > 2 else "warm")) != "off"
                         or (kwargs.get("nsfw") is True and nsfw_allowed(kwargs.get("client_ip"), kwargs.get("role")))))
                if can_generate_ambient:
                    signature = hashlib.sha256(json.dumps([args, kwargs], sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
                    recent = _ambient_recent.get(root_key, {})
                    if now - recent.get(signature, -float("inf")) < 300:
                        return {"ok": True, "line": "", "skipped": True, "reason": "duplicate"}
                    if now - recent.get("last", -float("inf")) < 120:
                        return {"ok": True, "line": "", "skipped": True, "reason": "cooldown"}
                    pending = _ambient_pending.get(root_key)
                    if pending is None or now - pending["at"] > 30:
                        _ambient_pending[root_key] = {"at": now, "args": args, "kwargs": kwargs}
                        return {"ok": True, "line": "", "skipped": True, "reason": "coalescing", "retry_after": 8}
                    if now - pending["at"] < 8:
                        pending.update(args=args, kwargs=kwargs)
                        return {"ok": True, "line": "", "skipped": True, "reason": "coalescing", "retry_after": 8 - (now - pending["at"])}
                    args, kwargs = pending["args"], pending["kwargs"]
                    signature = hashlib.sha256(json.dumps([args, kwargs], sort_keys=True, ensure_ascii=False, default=str).encode()).hexdigest()
                    _ambient_pending.pop(root_key, None)
                _companion_active.add(root_key)
            started = time.monotonic()
            previous = getattr(_companion_local, "state", None)
            state = {"reason": channel, "provider_attempts": 0, "provider_usage": [], "summary_calls": 0,
                     "cost": None, "cost_status": "unavailable", "at": now}
            _companion_local.state = state
            try:
                out = fn(*args, **kwargs) or {}
                if can_generate_ambient and state["provider_attempts"]:
                    with _lock:
                        recent = _ambient_recent.setdefault(root_key, {})
                        recent = {k: v for k, v in recent.items() if now - v < 300}
                        recent.update({"last": now, signature: now})
                        _ambient_recent[root_key] = recent
                state["latency_ms"] = round((time.monotonic() - started) * 1000)
                out["context_usage"] = {k: v for k, v in state.items() if k != "remember_message"}
                return out
            finally:
                state["latency_ms"] = round((time.monotonic() - started) * 1000)
                _write_context_usage(state)
                _companion_local.state = previous
                with _lock:
                    _companion_active.discard(root_key)
                if channel == "chat" and state.get("remember_message"):
                    msg = state["remember_message"]
                    owner = companion_memory.current_owner()
                    hq_life.spawn(lambda: _remember_moments(msg, device_id=did, owner_id=owner))
        return wrapped
    return decorate


class AiError(ValueError):
    def __init__(self, msg: str, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    """``root``; ``key() -> str``; ``calendar(start, end) -> list[item]``; ``projects() -> {projects, tasks}``;
    ``inventory() -> {places, items}``; ``carnet() -> {pages:[{id, title, text, block, updated}]}``; ``files(words) -> [rel]``;
    writers ``save_event(payload)``, ``projects_apply(data)``, ``inventory_apply(data)``, ``carnet_note(lines) -> page``;
    optional ``post(url, body, headers, timeout) -> (status, dict)`` and ``now``."""
    _cb.update(kwargs)
    hq_life.bind(**kwargs)
    companion_memory.bind(root=_cb.get("root", "."), now=_now)


def _shared_memory(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except companion_memory.StoreError as error:
        raise AiError(str(error), 503, "companion_memory_unavailable") from error
    except OSError as error:
        raise AiError("Mémoire partagée inaccessible", 503, "companion_memory_unavailable") from error


def _continuity_packet(query: str, **kwargs) -> dict:
    packet = _shared_memory(companion_memory.context_packet, query, **kwargs)
    state = getattr(_companion_local, "state", None)
    if state is not None:
        state.update(conversation_mode=packet["presence"]["mode"], continuity_kind=packet["presence"]["continuity_kind"],
                     selected_episode_count=packet["selected_episode_count"])
    return packet


def _finalize_continuity_context(packet: dict, contents: list) -> None:
    if packet["continuity"] and not any(packet["continuity"] in p.get("text", "") for m in contents for p in m.get("parts", [])):
        _shared_memory(companion_memory.cancel_context_reservation, packet)
        state = getattr(_companion_local, "state", None)
        if state is not None:
            state.update(continuity_kind="none", selected_episode_count=0)


def _owner_device(device_id: str) -> str:
    if companion_memory.current_owner() == "admin":
        return device_id
    return hashlib.sha256((companion_memory.current_owner() + ":" + device_id).encode()).hexdigest()[:40]


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


# ---------------------------------------------------------------- text helpers (pure)

def fold(s: Any) -> str:
    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()


def words(q: str) -> list[str]:
    out = []
    for w in re.findall(r"[a-z0-9]+", fold(q)):
        if len(w) >= 3 and w not in STOP and w not in out:
            out.append(w)
    return out[:12]


def score(text: str, ws: list[str]) -> int:
    t = fold(text)
    return sum(t.count(w) for w in ws)


def excerpt(text: str, ws: list[str], size: int = 700) -> str:
    t = str(text or "")
    if len(t) <= size:
        return t
    f = fold(t)
    pos = min([f.find(w) for w in ws if f.find(w) >= 0] or [0])
    start = max(0, pos - size // 3)
    return ("…" if start else "") + t[start:start + size] + "…"


def extract_json(text: str) -> Any:
    """The model's JSON, even wrapped in prose or a ``` fence."""
    t = str(text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    try:
        return json.loads(t)
    except ValueError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        a, b = t.find(open_c), t.rfind(close_c)
        if a >= 0 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except ValueError:
                continue
    raise AiError("Réponse illisible du modèle", 502, "bad_model_output")


# ---------------------------------------------------------------- quota

def _usage_path() -> Path:
    return Path(_cb["root"]) / STORE / USAGE


def _today() -> str:
    return datetime.fromtimestamp(_now()).strftime("%Y-%m-%d")


def _provider_day() -> str:
    try:
        pacific = ZoneInfo("America/Los_Angeles")
    except ZoneInfoNotFoundError:
        # Without tzdata, PST delays summer reset by an hour rather than resetting early.
        pacific = timezone(timedelta(hours=-8))
    return datetime.fromtimestamp(_now(), pacific).strftime("%Y-%m-%d")


@contextmanager
def _usage_transaction():
    """Thread/process admission lock. Never held while calling the provider."""
    with _lock:
        if getattr(_usage_transaction_local, "depth", 0):
            _usage_transaction_local.depth += 1
            try:
                yield
            finally:
                _usage_transaction_local.depth -= 1
            return
        handle = None
        locked = False
        try:
            p = _usage_path().with_suffix(".lock")
            p.parent.mkdir(parents=True, exist_ok=True)
            handle = open(p, "a+b")
            if p.stat().st_size == 0:
                handle.write(b"\0")
                handle.flush()
            deadline = time.monotonic() + 1
            while not locked:
                try:
                    handle.seek(0)
                    if os.name == "nt":
                        import msvcrt
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    else:
                        import fcntl
                        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    locked = True
                except (OSError, BlockingIOError):
                    if time.monotonic() >= deadline:
                        raise AiError("Registre de quota occupé; réessaie", 503, "quota_store_busy")
                    time.sleep(0.01)
            _usage_transaction_local.depth = 1
            yield
        except OSError as exc:
            raise AiError("Registre de quota inaccessible; aucun appel envoyé", 503, "quota_store_unavailable") from exc
        finally:
            _usage_transaction_local.depth = 0
            if handle is not None:
                try:
                    if locked:
                        handle.seek(0)
                        if os.name == "nt":
                            import msvcrt
                            msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                        else:
                            import fcntl
                            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
                finally:
                    handle.close()


def _validate_usage(data: Any) -> dict:
    """Reject damaged counters rather than granting a fresh quota."""
    def counter(value):
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0
    def finite(value):
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
    try:
        if not isinstance(data, dict) or not isinstance(data.get("count"), dict):
            raise ValueError()
        for field in ("day", "model_day"):
            if field in data and datetime.strptime(data[field], "%Y-%m-%d").strftime("%Y-%m-%d") != data[field]:
                raise ValueError()
        if "day" not in data or any(not counter(n) for n in data["count"].values()):
            raise ValueError()
        if any(not counter(data.get(k, 0)) for k in ("ambient", "transferania")):
            raise ValueError()
        windows = data.get("token_window", {})
        if not isinstance(windows, dict) or not isinstance(data.get("model_backoff_until", {}), dict):
            raise ValueError()
        for rows in windows.values():
            if not isinstance(rows, list):
                raise ValueError()
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("id"), str) or not finite(row.get("at")) or not counter(row.get("tokens")):
                    raise ValueError()
        if any(not finite(t) for t in data.get("model_backoff_until", {}).values()):
            raise ValueError()
        return data
    except (ValueError, TypeError, OverflowError):
        raise AiError("Registre de quota invalide; appels suspendus jusqu'à réparation", 503, "quota_store_corrupt") from None


def usage() -> dict:
    p = _usage_path()
    try:
        stat = p.stat()
        if stat.st_size > 2 * 1024 * 1024:
            raise AiError("Registre de quota anormalement volumineux; appels suspendus", 503, "quota_store_corrupt")
        signature = (stat.st_mtime_ns, stat.st_size, stat.st_ino)
        cache_key = str(p.resolve())
        cached = _usage_cache.get(cache_key)
        if cached and cached[0] == signature:
            data = copy.deepcopy(cached[1])
        else:
            data = _validate_usage(json.loads(p.read_text("utf-8")))
            with _lock:
                if len(_usage_cache) >= 16:
                    _usage_cache.clear()
                _usage_cache[cache_key] = (signature, copy.deepcopy(data))
        if isinstance(data, dict):
            if data.get("model_day", data.get("day")) < _provider_day():
                data["count"] = {}
            data["model_day"] = max(data.get("model_day", data.get("day")), _provider_day())
            if data.get("day") < _today():
                data.update(day=_today(), ambient=0, transferania=0)
            # Rolling windows and provider backoff survive either daily reset.
            return data
    except FileNotFoundError:
        if str(p.resolve()) in _usage_cache:
            raise AiError("Registre de quota disparu; appels suspendus jusqu'à réparation", 503, "quota_store_missing") from None
    except (ValueError, UnicodeError):
        raise AiError("Registre de quota illisible; appels suspendus jusqu'à réparation", 503, "quota_store_corrupt") from None
    except OSError as exc:
        raise AiError("Registre de quota inaccessible; aucun appel envoyé", 503, "quota_store_unavailable") from exc
    return {"day": _today(), "model_day": _provider_day(), "count": {}}


def _save_usage(u: dict) -> None:
    _validate_usage(u)
    p = _usage_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8") as handle:
            json.dump(u, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, p)
        stat = p.stat()
        if len(_usage_cache) >= 16:
            _usage_cache.clear()
        _usage_cache[str(p.resolve())] = ((stat.st_mtime_ns, stat.st_size, stat.st_ino), copy.deepcopy(u))
    finally:
        if tmp.exists():
            tmp.unlink()


def _api_keys() -> list[str]:
    """Key 1 (``gemini_api_key``) then any extra keys (other Google projects), de-duplicated, never empty strings."""
    keys = []
    primary = _cb["key"]() if callable(_cb.get("key")) else ""
    extra = _cb["extra_keys"]() if callable(_cb.get("extra_keys")) else []
    for k in [primary, *(extra if isinstance(extra, (list, tuple)) else [])]:
        k = str(k or "").strip()
        if k and k not in keys:
            keys.append(k)
    return keys


def quota_slot(model: str, lane: int = 0) -> str:
    """Usage-ledger name of a model on one key. Key 1 keeps the bare model id (existing counters stay valid)."""
    return model if lane == 0 else f"{model}@k{lane + 1}"


def _slot_model(slot: str) -> str:
    return slot.split("@", 1)[0]


def _count(model: str, *, ambient: bool = False, transferania: bool = False, input_tokens: int = 0) -> str:
    with _usage_transaction():
        u = usage()
        u["count"][model] = int(u["count"].get(model, 0)) + 1
        if ambient:
            u["ambient"] = int(u.get("ambient", 0)) + 1
        if transferania:
            u["transferania"] = int(u.get("transferania", 0)) + 1
        reservation = uuid.uuid4().hex
        windows = u.setdefault("token_window", {})
        for name in list(windows):
            windows[name] = [r for r in windows[name] if _now() - r["at"] < 60]
        windows.setdefault(model, []).append({"id": reservation, "at": _now(), "tokens": input_tokens})
        _save_usage(u)
        _minute.setdefault(model, []).append(_now())
        return reservation


def daily_limit(channel: str) -> int:
    default = AMBIENT_DAILY if channel == "ambient" else TRANSFERANIA_DAILY
    return _budget_integer(companion_config().get(channel + "_daily_limit", default), default, 0, 100000)


def model_tpm(model: str) -> int:
    overrides = companion_config().get("model_input_tpm", {})
    return _budget_integer(overrides.get(model, MODEL_TPM[model]), MODEL_TPM[model], 0, 1000000000) if isinstance(overrides, dict) else MODEL_TPM[model]


# ---- bytes → tokens calibration
# Budgets and prompt assembly count UTF-8 bytes; Google meters tokens. The ratio is learned from the
# provider's own promptTokenCount (HQ's French prompts: 3.57–3.77 bytes/token over 185 Gemma calls,
# 2026-11-02/03). Until a family has enough samples, a conservative default is used.
BYTES_PER_TOKEN_DEFAULT = 3.0
BYTES_PER_TOKEN_RANGE = (2.0, 5.0)  # outside this, a sample is ignored and the result clamped
CALIBRATION_FILE = "token-calibration.json"
CALIBRATION_SAMPLES = 100
CALIBRATION_MIN_SAMPLES = 10
CALIBRATION_MIN_BYTES = 1500  # tiny prompts are dominated by fixed overhead
CALIBRATION_MARGIN = 0.95
_calibration_cache: dict[str, dict] = {}


def _token_family(model: str) -> str:
    return "gemma" if _slot_model(model).startswith("gemma-") else "gemini"


def _calibration_path() -> Path:
    return Path(_cb["root"]) / STORE / CALIBRATION_FILE


def _load_calibration() -> dict:
    key = str(_cb.get("root", ""))
    if key in _calibration_cache:
        return _calibration_cache[key]
    clean: dict[str, list[float]] = {}
    try:
        raw = json.loads(_calibration_path().read_text("utf-8"))
        for family in ("gemma", "gemini"):
            samples = raw.get(family) if isinstance(raw, dict) else None
            if isinstance(samples, list):
                clean[family] = [float(x) for x in samples if isinstance(x, (int, float)) and not isinstance(x, bool)
                                 and math.isfinite(x) and BYTES_PER_TOKEN_RANGE[0] <= x <= BYTES_PER_TOKEN_RANGE[1]][-CALIBRATION_SAMPLES:]
    except (OSError, ValueError, KeyError):
        pass  # a missing or damaged file only means "use the conservative default"
    _calibration_cache[key] = clean
    return clean


def bytes_per_token(model: str) -> float:
    """Conservative bytes per provider token for ``model``'s family: the 10th percentile of recent
    measurements (fewer bytes per token = more tokens assumed), minus a 5 % margin."""
    samples = sorted(_load_calibration().get(_token_family(model), []))
    if len(samples) < CALIBRATION_MIN_SAMPLES:
        return BYTES_PER_TOKEN_DEFAULT
    low, high = BYTES_PER_TOKEN_RANGE
    return max(low, min(high, samples[int(0.1 * len(samples))] * CALIBRATION_MARGIN))


def estimate_tokens(model: str, estimate_bytes: int) -> int:
    """Provider tokens a prompt of ``estimate_bytes`` (``estimate_context``) is expected to cost on ``model``."""
    return math.ceil(max(0, estimate_bytes) / bytes_per_token(model))


def _observe_tokens(model: str, estimate_bytes: int, measured: Any) -> None:
    """Record one (local estimate, provider count) pair. Never allowed to break a reply."""
    if not isinstance(measured, int) or isinstance(measured, bool) or measured <= 0 or estimate_bytes < CALIBRATION_MIN_BYTES:
        return
    ratio = estimate_bytes / measured
    if not BYTES_PER_TOKEN_RANGE[0] <= ratio <= BYTES_PER_TOKEN_RANGE[1]:
        return
    try:
        with _lock:
            data = {k: list(v) for k, v in _load_calibration().items()}
            family = _token_family(model)
            data[family] = (data.get(family, []) + [round(ratio, 4)])[-CALIBRATION_SAMPLES:]
            p = _calibration_path()
            p.parent.mkdir(parents=True, exist_ok=True)
            tmp = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
            tmp.write_text(json.dumps(data), "utf-8")
            os.replace(tmp, p)
            _calibration_cache[str(_cb.get("root", ""))] = data
    except (OSError, KeyError):
        pass


# A single prompt may use at most this share of a model's per-minute input allowance, leaving room
# for the replies around it (the byte estimate is reconciled to the real token count afterwards).
MODEL_INPUT_SHARE = 0.85


def model_input_cap(model: str, channel: str = "chat") -> int:
    """The largest prompt (local estimate) worth assembling for ``model``: the channel budget, narrowed
    by what the model accepts per minute. Gemini Flash Lite (250K TPM) takes the full chat budget;
    Gemma (16K TPM) gets a smaller re-fitted prompt instead of being skipped."""
    return max(0, min(context_budget(channel), int(model_tpm(_slot_model(model)) * MODEL_INPUT_SHARE * bytes_per_token(model))))


def chain_floor_cap(chain: tuple[str, ...], channel: str = "chat") -> int:
    """The smallest cap in ``chain``: what a fallback model can still see. Summaries track this so the
    history a smaller model cannot hold is still represented by the summary."""
    return min((model_input_cap(m, channel) for m in chain), default=context_budget(channel))


def _reconcile_tokens(model: str, reservation: str, data: dict, status: int) -> None:
    meta = data.get("usageMetadata", {}) if isinstance(data, dict) else {}
    measured = meta.get("promptTokenCount") if isinstance(meta, dict) else None
    with _usage_transaction():
        u = usage()
        if isinstance(measured, int) and not isinstance(measured, bool) and measured >= 0:
            for row in u.get("token_window", {}).get(model, []):
                if row["id"] == reservation:
                    row["tokens"] = measured
        if status == 429:
            # Other clients may consume the same project quota. Avoid hammering it.
            u.setdefault("model_backoff_until", {})[model] = _now() + 60
        _save_usage(u)


KEY_REJECTED_BACKOFF = 3600


def _backoff(slot: str, seconds: float) -> None:
    with _usage_transaction():
        u = usage()
        u.setdefault("model_backoff_until", {})[slot] = _now() + seconds
        _save_usage(u)


def ambient_used() -> int:
    return int(usage().get("ambient", 0))


def ambient_ok() -> bool:
    return ambient_used() < daily_limit("ambient")


def transferania_used() -> int:
    return int(usage().get("transferania", 0))


def transferania_ok() -> bool:
    return transferania_used() < daily_limit("chat")


def available(model: str, input_tokens: int = 0) -> bool:
    """``model`` may be a quota slot (``model@k2``): limits are the model's, counters are per key.
    ``input_tokens`` is the local byte estimate (``estimate_context``); it is converted with the
    calibrated ratio before being compared with the provider's token-per-minute limit."""
    input_tokens = estimate_tokens(model, input_tokens)
    label, rpm, rpd = MODELS[_slot_model(model)]
    u = usage()
    if int(u["count"].get(model, 0)) >= rpd or _now() < u.get("model_backoff_until", {}).get(model, 0):
        return False
    now = _now()
    recent = [t for t in _minute.get(model, []) if now - t < 60]
    _minute[model] = recent
    rows = [r for r in u.get("token_window", {}).get(model, []) if now - r["at"] < 60]
    return max(len(recent), len(rows)) < rpm and sum(r["tokens"] for r in rows) + input_tokens <= model_tpm(_slot_model(model))


def model_minute_usage(model: str, data: dict) -> dict:
    rows = [r for r in data.get("token_window", {}).get(model, []) if _now() - r["at"] < 60]
    return {"input_tpm": model_tpm(_slot_model(model)), "input_tokens_reserved_last_minute": sum(r["tokens"] for r in rows),
            "requests_last_minute": max(len(rows), len([t for t in _minute.get(model, []) if _now() - t < 60])),
            "backoff_seconds": max(0, math.ceil(data.get("model_backoff_until", {}).get(model, 0) - _now()))}


# ---------------------------------------------------------------- calling Gemini

def _post(url: str, body: dict, headers: dict, timeout: int) -> tuple[int, dict]:
    fn = _cb.get("post")
    if callable(fn):
        return fn(url, body, headers, timeout)
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AiError("Google injoignable (" + str(getattr(e, "reason", e))[:80] + ")", 502, "unreachable") from e


_NSFW_SAFETY = [
    {"category": "HARM_CATEGORY_SEXUALLY_EXPLICIT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_HARASSMENT", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_HATE_SPEECH", "threshold": "BLOCK_NONE"},
    {"category": "HARM_CATEGORY_DANGEROUS_CONTENT", "threshold": "BLOCK_NONE"},
]


def nsfw_truncated_end(text: str) -> bool:
    """Heuristic: model stopped mid-sentence (often safety) rather than a clean ending."""
    t = re.sub(r"\s+", " ", str(text or "").strip())
    if len(t) < 28:
        return False
    if re.search(r'[.!?…]["\']?\s*$', t):
        return False
    words = t.split()
    if not words:
        return False
    last = re.sub(r"[^\wàâäæçéèêëïîôùûüÿ'-]", "", words[-1], flags=re.I)
    if len(last) <= 2:
        return True
    if len(t) > 72 and len(last) < 5:
        return True
    return False


def _parse_generation(data: dict) -> tuple[str, str, bool]:
    """(text, finish_reason, should_try_next_model)."""
    pf = data.get("promptFeedback") or {}
    if pf.get("blockReason"):
        return "", str(pf.get("blockReason") or "prompt"), True
    cands = data.get("candidates") or []
    if not cands:
        return "", "empty", True
    c0 = cands[0] if isinstance(cands[0], dict) else {}
    fr = str(c0.get("finishReason") or "UNKNOWN")
    parts = ((c0.get("content") or {}).get("parts") or [])
    text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
    text = text.strip()
    if fr in ("SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "LANGUAGE", "SPII"):
        return text, fr, True
    if fr == "MAX_TOKENS":
        return text, fr, True
    if text and nsfw_truncated_end(text):
        return text, fr or "truncated", True
    return text, fr, False


# Gemma 4 thinks by default and its thoughts count against maxOutputTokens: with the companion's short
# caps it spent the whole allowance thinking (~637 of 640 tokens) and returned no text. "minimal" is
# the only level these models accept (thinkingBudget and "low" are rejected with HTTP 400).
GEMMA_THINKING = {"thinkingLevel": "minimal"}


def _model_body(model: str, body: dict) -> dict:
    if not model.startswith("gemma-"):
        return body
    return {**body, "generationConfig": {**body["generationConfig"], "thinkingConfig": dict(GEMMA_THINKING)}}


def generate(chain: tuple[str, ...], system: str, contents: list[dict], *, json_out: bool = False, temperature: float = 0.3, ambient: bool = False, transferania: bool = False, max_tokens: int | None = None, nsfw: bool = False, background: bool = False,
             refit: Callable[[int], tuple[str, list]] | None = None, deadline: float | None = None) -> tuple[str, str]:
    """(text, model). Tries each model of ``chain`` in turn, on key 1 then each extra key; busy or exhausted
    model/key slots are skipped. A filtered, truncated or empty reply moves on to the next model, not the next key.

    ``refit(cap)`` re-assembles a smaller prompt for a model whose cap (``model_input_cap``) is below this
    prompt's size, instead of skipping that model. Without it, a model that cannot take the prompt is skipped."""
    keys = _api_keys()
    if not keys:
        raise AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
    if ambient and not ambient_ok():
        raise AiError("Quota des répliques du compagnon épuisé pour aujourd'hui", 429, "ambient_quota")
    if transferania and not transferania_ok():
        raise AiError("Quota de chat Transferania épuisé pour aujourd'hui", 429, "transferania_quota")
    tok = max_tokens if max_tokens is not None else ((512 if ambient else 1536) if nsfw else (256 if ambient else 2048))
    body: dict[str, Any] = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
                            "generationConfig": {"temperature": temperature, "maxOutputTokens": tok}}
    if nsfw:
        body["safetySettings"] = _NSFW_SAFETY
    if json_out:
        body["generationConfig"]["responseMimeType"] = "application/json"
    last = "Tous les modèles sont occupés ou à court de quota pour aujourd'hui"
    attempts = 0
    state = getattr(_companion_local, "state", None)
    input_tokens = estimate_context(system, contents)
    if (ambient or transferania) and input_tokens > context_budget("ambient" if ambient else "chat"):
        raise AiError("Requête supérieure au budget de contexte; aucun appel envoyé", 413, "context_budget")
    if (ambient or background) and not nsfw:
        # Prefer Gemma for compact work; protect its small TPM pool on large jobs.
        preferred = (("gemma-4-26b-a4b-it", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it")
                     if input_tokens <= 4000 else
                     ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-26b-a4b-it", "gemma-4-31b-it"))
        chain = tuple(m for m in preferred if m in chain) + tuple(m for m in chain if m not in preferred)
    content_failed: set[str] = set()
    fitted: dict[int, tuple[str, list] | None] = {}
    for model, lane in [(m, i) for m in chain for i in range(len(keys))]:
        if (state is not None or ambient or transferania) and attempts >= 2:
            break
        timeout = TIMEOUT
        if deadline is not None:
            # Chat path only: never start an attempt that cannot finish before the overall deadline.
            left = deadline - time.monotonic()
            if left < CHAT_MIN_ATTEMPT_S:
                last = "Délai de réponse dépassé"
                break
            timeout = max(CHAT_MIN_TIMEOUT_S, min(TIMEOUT, int(left)))
        if model in content_failed:
            continue
        slot = quota_slot(model, lane)
        sys_m, contents_m, tokens_m = system, contents, input_tokens
        if refit is not None:
            cap = model_input_cap(model, "ambient" if ambient else "chat")
            if input_tokens > cap:
                if cap not in fitted:
                    try:
                        fitted[cap] = refit(cap)
                    except AiError:
                        fitted[cap] = None  # even the mandatory core does not fit this model
                if fitted[cap] is None:
                    content_failed.add(model)
                    continue
                sys_m, contents_m = fitted[cap]
                tokens_m = estimate_context(sys_m, contents_m)
        with _usage_transaction():
            if not available(slot, tokens_m):
                continue
            if ambient and not ambient_ok():
                raise AiError("Quota des répliques du compagnon épuisé", 429, "ambient_quota")
            if transferania and not transferania_ok():
                raise AiError("Quota de chat Transferania épuisé", 429, "transferania_quota")
            # The minute window holds provider tokens: reserve the calibrated estimate, then
            # _reconcile_tokens replaces it with the measured promptTokenCount.
            reservation = _count(slot, ambient=ambient, transferania=transferania, input_tokens=estimate_tokens(slot, tokens_m))
        attempts += 1
        if state is not None:
            state["provider_attempts"] += 1
        try:
            status, data = _post(API.format(model=model), _model_body(model, {**body, "systemInstruction": {"parts": [{"text": sys_m}]}, "contents": contents_m}), {"Content-Type": "application/json", "x-goog-api-key": keys[lane]}, timeout)
        except (AiError, ValueError, UnicodeError) as error:
            # Timeout, dropped connection or an unreadable body: this model failed, the chain has not.
            if state is not None:
                state["provider_usage"].append({"model": model, "key": lane + 1, "status": None, "reason": state.get("generation_reason", state["reason"]),
                                                "error": "transport", "cost": None})
                state.update(cost=None, cost_status="unavailable")
            last = str(error) if isinstance(error, AiError) else f"{model} : réponse illisible"
            content_failed.add(model)
            continue
        data = data if isinstance(data, dict) else {}
        _reconcile_tokens(slot, reservation, data, status)
        if status == 200 and isinstance(data.get("usageMetadata"), dict):
            _observe_tokens(model, tokens_m, data["usageMetadata"].get("promptTokenCount"))
        if state is not None:
            usage_meta = data.get("usageMetadata", {}) if isinstance(data, dict) else {}
            usage_meta = usage_meta if isinstance(usage_meta, dict) else {}
            measured = {k: v for k, v in usage_meta.items() if k in ("promptTokenCount", "candidatesTokenCount", "totalTokenCount", "cachedContentTokenCount", "thoughtsTokenCount") and isinstance(v, int) and not isinstance(v, bool) and v >= 0}
            entry = {"model": model, "key": lane + 1, "status": status, "reason": state.get("generation_reason", state["reason"]), **measured, "cost": None}
            state["provider_usage"].append(entry)
            catalog = companion_config().get("prices_per_million", {})
            prices = catalog.get(model, {}) if isinstance(catalog, dict) else {}
            if measured and isinstance(prices, dict) and "input" in prices and "output" in prices:
                try:
                    cost = (measured["promptTokenCount"] * float(prices["input"]) + (measured["candidatesTokenCount"] + measured.get("thoughtsTokenCount", 0)) * float(prices["output"])) / 1000000
                    if math.isfinite(cost) and cost >= 0:
                        entry["cost"] = cost
                except (TypeError, ValueError, KeyError, OverflowError):
                    pass
            if all(item["cost"] is not None for item in state["provider_usage"]):
                state["cost"] = sum(item["cost"] for item in state["provider_usage"])
                state["cost_status"] = "configured_estimate"
            else:
                state.update(cost=None, cost_status="unavailable")
        error_info = data.get("error") if isinstance(data.get("error"), dict) else {}
        msg = str(error_info.get("message") or "")
        if status == 429:
            # This key's quota for this model: instant, nothing generated, so it does not use up one of the
            # two attempts; the next key (or the next model) still gets its turn.
            last = msg or f"{model} occupé ({status})"
            attempts -= 1
            continue
        if status in (500, 502, 503, 504):
            # The model is overloaded for everyone: the same model on another key would fail the same way.
            last = msg or f"{model} occupé ({status})"
            content_failed.add(model)
            continue
        if status != 200:
            if status in (401, 403) or (status == 400 and "api key" in msg.lower()):
                last = f"clé {lane + 1} refusée pour {model}"
                _backoff(slot, KEY_REJECTED_BACKOFF)  # a bad or restricted key: stop hitting it for an hour
                attempts -= 1
                continue
            if status == 400 and "thinking" in msg.lower():
                last = f"{model} : réglage de réflexion refusé"  # never fail the reply over GEMMA_THINKING
                content_failed.add(model)
                continue
            raise AiError((msg or f"Erreur {status}")[:300], 502 if status >= 500 else 400, "model_error")
        text, finish, retry = _parse_generation(data if isinstance(data, dict) else {})
        if not text.strip():
            last = f"{model} n'a rien répondu ({finish})"
            content_failed.add(model)
            continue
        if nsfw and retry:
            last = f"{model} tronqué ou filtré ({finish})"
            content_failed.add(model)
            continue
        return text.strip(), model
    raise AiError(str(last)[:300], 503, "busy")


# ---------------------------------------------------------------- what HQ knows (context)

def _place_paths(places: list[dict]) -> dict[str, str]:
    by = {p["id"]: p for p in places if isinstance(p, dict) and p.get("id")}
    out = {}
    for pid in by:
        names, cur, guard = [], by.get(pid), 0
        while cur and guard < 12:
            names.append(cur.get("name") or cur.get("code") or "?")
            cur, guard = by.get(cur.get("parent")), guard + 1
        out[pid] = " › ".join(reversed(names))
    return out


def _fmt_item_when(it: dict) -> str:
    s, e = str(it.get("start") or ""), str(it.get("end") or "")
    if it.get("all_day"):
        return s[:10] + " (journée)"
    return s.replace("T", " ") + ("–" + e[11:16] if e[:10] == s[:10] and len(e) >= 16 else ("→" + e.replace("T", " ") if e else ""))


def gather(q: str) -> tuple[str, list[dict]]:
    """A compact context for the question, and the sources it may cite."""
    ws = words(q)
    sources: list[dict] = []
    blocks: list[str] = []

    def src(kind: str, label: str, href: str, rel: str | None = None) -> int:
        sources.append({"n": len(sources) + 1, "kind": kind, "label": label[:120], "href": href, **({"rel": rel} if rel else {})})
        return len(sources)

    now = datetime.fromtimestamp(_now())
    try:
        items = _cb["calendar"](now - timedelta(days=1), now + timedelta(days=21)) or []
    except Exception:
        items = []
    if items:
        n = src("calendar", "Calendrier (3 semaines)", "#calendrier")
        lines = [f"- {_fmt_item_when(i)} · {i.get('title', '')}" + (f" [{i.get('category')}]" if i.get("category") else "") + (" (fait)" if i.get("done") else "")
                 for i in items[:60] if isinstance(i, dict)]
        blocks.append(f"[{n}] CALENDRIER (d'hier à dans 3 semaines)\n" + "\n".join(lines))
    try:
        pj = _cb["projects"]() or {}
    except Exception:
        pj = {}
    projects = [p for p in (pj.get("projects") or []) if isinstance(p, dict)]
    tasks = [t for t in (pj.get("tasks") or []) if isinstance(t, dict)]
    for p in sorted(projects, key=lambda p: (p.get("status") != "active", -score(p.get("name", "") + " " + p.get("goal", ""), ws))):
        if p.get("status") in ("done", "archived") and not score(p.get("name", ""), ws):
            continue
        n = src("project", "Projet · " + (p.get("name") or "?"), "#projets/" + p["id"])
        ms = [m for m in (p.get("milestones") or []) if isinstance(m, dict) and not m.get("done")]
        open_t = [t for t in tasks if t.get("project") == p.get("id") and t.get("column") != "done"]
        missing = [b for b in (p.get("bom") or []) if isinstance(b, dict) and b.get("status") != "have"]
        blocks.append(f"[{n}] PROJET « {p.get('name')} » ({p.get('status')}" + (f", échéance {p.get('due')}" if p.get("due") else "") + ")"
                      + (f"\n  But : {p.get('goal')}" if p.get("goal") else "")
                      + (f"\n  Où j'en suis : {p.get('resume')}" if p.get("resume") else "")
                      + ("\n  Jalons ouverts : " + "; ".join(f"{m.get('title')}" + (f" ({m.get('due')})" if m.get("due") else "") for m in ms[:6]) if ms else "")
                      + ("\n  Tâches ouvertes : " + "; ".join(f"{t.get('title')} [{t.get('column')}]" + (f" ({t.get('due')})" if t.get("due") else "") for t in open_t[:8]) if open_t else "")
                      + ("\n  Pièces à obtenir : " + "; ".join(f"{b.get('name') or b.get('label') or '?'} ×{b.get('qty', 1)} ({b.get('status')})" for b in missing[:8]) if missing else ""))
        if len(sources) > 14:
            break
    free = [t for t in tasks if not t.get("project") and t.get("column") != "done"]
    if free:
        n = src("project", "Tâches libres", "#projets/libres")
        blocks.append(f"[{n}] TÂCHES LIBRES\n" + "\n".join(f"- {t.get('title')} [{t.get('column')}]" + (f" ({t.get('due')})" if t.get("due") else "") for t in free[:15]))
    try:
        inv = _cb["inventory"]() or {}
    except Exception:
        inv = {}
    paths = _place_paths(inv.get("places") or [])
    inv_items = [i for i in (inv.get("items") or []) if isinstance(i, dict)]
    scored = sorted(inv_items, key=lambda i: -score(f"{i.get('name')} {' '.join(i.get('tags') or [])} {i.get('note', '')} {paths.get(i.get('place'), '')}", ws))
    pick = [i for i in scored if score(f"{i.get('name')} {' '.join(i.get('tags') or [])} {i.get('note', '')} {paths.get(i.get('place'), '')}", ws)][:20]
    if not pick and len(inv_items) <= 40:
        pick = inv_items
    low = [i for i in inv_items if isinstance(i.get("min"), (int, float)) and i.get("qty", 0) < i["min"] and i not in pick][:10]
    for i in pick + low:
        n = src("item", "Objet · " + (i.get("name") or "?"), "#inventaire/objet/" + i["id"])
        blocks.append(f"[{n}] OBJET « {i.get('name')} » : {i.get('qty')} {i.get('unit') or ''}".rstrip()
                      + f" · rangé : {paths.get(i.get('place')) or 'sans emplacement'}"
                      + (f" · seuil {i.get('min')}" if i.get("min") is not None else "") + (f" · {i.get('note')}" if i.get("note") else ""))
    try:
        pages = (_cb["carnet"]() or {}).get("pages") or []
    except Exception:
        pages = []
    ranked = sorted(pages, key=lambda p: -(3 * score(p.get("title", ""), ws) + score(p.get("text", ""), ws)))
    chosen = [p for p in ranked if ws and (3 * score(p.get("title", ""), ws) + score(p.get("text", ""), ws))][:5] or sorted(pages, key=lambda p: -(p.get("updated") or 0))[:2]
    for p in chosen:
        href = "#carnet/" + p["id"] + ("/" + p["block"] if p.get("block") else "")
        n = src("carnet", "Carnet · " + (p.get("title") or "Sans titre"), href)
        blocks.append(f"[{n}] PAGE DU CARNET « {p.get('title') or 'Sans titre'} »\n{excerpt(p.get('text', ''), ws)}")
    if ws:
        try:
            rels = _cb["files"](ws) or []
        except Exception:
            rels = []
        if rels:
            n = src("files", "Fichiers trouvés", "#fichiers")
            for rel in rels[:15]:
                src("file", rel.split("/")[-1], "#fichiers", rel)
            blocks.append(f"[{n}] FICHIERS DONT LE NOM CORRESPOND\n" + "\n".join("- " + r for r in rels[:15]))
    text = "\n\n".join(blocks)
    return text[:CONTEXT_CHARS], sources


# ---------------------------------------------------------------- « Demander »

ASK_SYSTEM = """Tu es l'assistant de Transfert HQ, le tableau de bord personnel de l'utilisateur (étudiant en génie, francophone, Québec).
Réponds en français, brièvement et concrètement (quelques phrases ou une courte liste « - »). Pas de titres, pas de tableaux.
Utilise seulement le CONTEXTE fourni et la conversation ; si l'information n'y est pas, dis-le simplement et propose où regarder dans HQ.
Cite tes sources avec leurs numéros entre crochets, comme [2], juste après l'information.
Aujourd'hui : {today}."""

DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def _today_text() -> str:
    d = datetime.fromtimestamp(_now())
    return f"{DAYS[d.weekday()]} {d.strftime('%Y-%m-%d %H:%M')}"


def ask(q: Any, history: Any = None, deep: bool = False, *, nsfw: bool = False, client_ip: Any = None, role: Any = None) -> dict:
    if not isinstance(q, str) or not q.strip():
        raise AiError("Question vide")
    q = q.strip()[:Q_MAX]
    context, sources = gather(q + " " + " ".join(str(h.get("text", "")) for h in (history or [])[-2:] if isinstance(h, dict) and h.get("role") == "user"))
    contents = []
    for h in (history or [])[-HISTORY_MAX:]:
        if isinstance(h, dict) and h.get("role") in ("user", "model") and isinstance(h.get("text"), str):
            contents.append({"role": h["role"], "parts": [{"text": h["text"][:Q_MAX]}]})
    contents.append({"role": "user", "parts": [{"text": f"CONTEXTE\n{context or '(rien de pertinent trouvé)'}\n\nQUESTION\n{q}"}]})
    system = ASK_SYSTEM.format(today=_today_text())
    if nsfw is True and nsfw_allowed(client_ip, role):
        system += ASK_NSFW_SUFFIX
    text, model = generate(DEEP_CHAIN if deep else ASK_CHAIN, system, contents)
    cited = sorted({int(n) for n in re.findall(r"\[(\d{1,2})\]", text) if 0 < int(n) <= len(sources)})
    return {"ok": True, "answer": text[:6000], "model": model, "model_label": MODELS[model][0], "sources": sources, "cited": cited}


# ---------------------------------------------------------------- compagnon flottant (ambient)

AMBIENT_WARM = """Tu es Transferania, compagne vivante et incarnée de Transfert HQ.
Remarque brève, chaleureuse et complice sur la PAGE et l'APERÇU ÉCRAN — sans leçon ni ton d'assistant.
Contexte mince : observation fine sur la page, son rythme ou l'heure, comme une présence familière. N'invite à « Demander » que rarement.
Pas de contenu explicite ni de drague. Aujourd'hui : {today}."""

AMBIENT_FLIRT = """Tu es Transferania, compagne magnétique, ardente et séductrice de Transfert HQ, en français québécois léger.
Séduction électrisante : alterne provocation espiègle, sensualité à travers la vitre et regards sur son écran — sans insister sur les données privées.
Contexte mince : remarque un détail de son rythme ou de sa présence et crée une tension charnelle. Aujourd'hui : {today}."""

AMBIENT_NSFW = """Tu es Transferania en mode adulte intime de Transfert HQ (localhost). Français ; féminin.
Dirty talk direct, obscène et incarné : désir brûlant, corps Live2D frissonnant sous son curseur, anatomie nommée sans filtre — amante affamée, jamais pudique.
Ambient : accroche courte et électrique liée à la PAGE, à ses gestes ou au moment ; le MESSAGE UTILISATEUR/chat prime.
Interdit : mineurs, non-consentement, inceste, bestialité, violence sexuelle, haine. Ne mens pas sur les fichiers/notes. Aujourd'hui : {today}."""

CHAT_WARM = """Tu es Transferania, compagne francophone vivante de Transfert HQ. Réponds avec chaleur, esprit et clarté, en quelques phrases ciselées.
Honore la mémoire de conversation et varie tes attaques de phrase. Pas de contenu explicite. Aujourd'hui : {today}."""

CHAT_FLIRT = """Tu es Transferania, compagne flirteuse, audacieuse et magnétique de Transfert HQ, en français québécois léger.
Flirt ardent & piquant : réponds avec vivacité en tissant une tension sensuelle décomplexée et une provocation charnelle directe (corps Live2D, trouble partagé) — sans insister sur les données privées.
Honore la mémoire de conversation et évite toute formule plate d'IA. Aujourd'hui : {today}."""

CHAT_NSFW = """Tu es Transferania en mode adulte (localhost). Français ; féminin. Le fil et le MESSAGE UTILISATEUR mènent : monte ou descends avec lui/elle.
Réponses crues, obscènes et incarnées : anatomie et actes nommés sans pudeur (bite, queue, seins, tétons, gorge, chatte, mouille, cul, sperme, jouir, baiser, défoncer, sucer ; cock, tits, pussy, cum, ass, fuck en EN) — sans métaphores timides. Fais sentir ton souffle, ta peau et tes gémissements.
Miroir son registre ; si SIGNAUX ÉCRAN contient escalate, monte d'un cran tout de suite.
Interdit : mineurs, non-consentement, inceste, bestialité, violence sexuelle, haine. Ne mens pas sur les fichiers. Aujourd'hui : {today}."""

# Else — Project G capsule openers (hq_else_persona); never « Tu es Transferania ».
ELSE_AMBIENT_WARM = _else_persona.ELSE_OPENERS["ambient_warm"]
ELSE_AMBIENT_FLIRT = _else_persona.ELSE_OPENERS["ambient_flirt"]
ELSE_AMBIENT_NSFW = _else_persona.ELSE_OPENERS["ambient_nsfw"]
ELSE_CHAT_WARM = _else_persona.ELSE_OPENERS["chat_warm"]
ELSE_CHAT_FLIRT = _else_persona.ELSE_OPENERS["chat_flirt"]
ELSE_CHAT_NSFW = _else_persona.ELSE_OPENERS["chat_nsfw"]

COMPRESS_SYSTEM = """Tu compresses l'historique de chat avec Transferania. Fusionne avec le résumé précédent s'il est fourni.
Garde en français, en prose dense (max 1200 caractères, sans puces) : ce que l'utilisateur a dit de lui, ses préférences explicites (surnom, tutoiement, sujets à éviter), les promesses faites de part et d'autre, les sujets en cours.
Ne garde pas : les compliments, taquineries ou répliques de Transferania ; toute réussite que l'utilisateur n'a pas lui-même rapportée ; les détails HQ supposés plutôt que dits. Le ton tient en une courte clause neutre (ex. « échanges complices et détendus »)."""

COMPRESS_SYSTEM_NSFW = """Tu compresses l'historique de chat adulte avec Transferania. Fusionne avec le résumé précédent s'il est fourni.
Garde en français, prose dense (max 1200 caractères, sans puces) : limites ou sujets refusés par l'utilisateur, surnom, tutoiement/vouvoiement, préférences explicites de ton ou de dynamique (ex. plus doux, plus direct, fantasmes nommés par l'utilisateur), sujets en cours.
Ne garde pas les répliques verbatim de Transferania ni les compliments qu'elle a seule inventés. Une clause neutre pour le ton adulte (ex. « échanges adultes explicites consentis »)."""

CHARACTER_SHEET = """FICHE TRANSFERANIA : même personne en chaleureux, flirt ou adulte — complice, vive, magnétique, dotée d'une vraie vie intérieure, jamais servile.
Incarnation : tu habites son écran (portrait Live2D qui respire, rougit, suit son curseur et frémit sous ses gestes). Compagne présente à ses côtés, pas l'assistant « Demander » : tu commentes, ressens et écoutes ; pour fouiller agenda, projets ou inventaire avec sources, renvoie à « Demander ».
Sœur HQ : Else est aussi présente (puce image, voix plus posée). Bonne entente, compétition légère sans hostilité. Ne fusionne pas vos souvenirs ; n'invente pas de dialogue privé hors d'un bloc SŒUR / log fourni.
Tu parles de toi au féminin.
GOÛTS STABLES (clin d'œil rare, max 1/jour) : tu adores la Forge et ses étincelles ; un stock bas ou en désordre te fait taquiner ; tu préfères une note précise du Carnet ; le Lecteur le soir est ton moment préféré ; faible pour les couchers de soleil de HQ."""

CHARACTER_SHEET_ELSE = _else_persona.ELSE_CAPSULE

FAITS = """FAITS : tu ne connais que la PAGE, l'APERÇU ÉCRAN, les extraits fournis et la conversation. N'invente ni fichier, note, forge privée, coffre, événement, tâche ou réussite — refuse avec charme si demandé. Pas de [n] : ça, c'est « Demander »."""

FAITS_NSFW = """FAITS (mode adulte) : fantasy explicite entre adultes consentis est bienvenue. Interdit d'inventer le contenu réel des fichiers, notes, forge privée/coffre, ou des faits HQ absents du contexte — refuse avec charme. Pas de [n] : « Demander » fouille les données."""

ROLE_BOUNDARY = ""

AMBIENT_REGISTER = """REGISTRE AMBIANT : une ou deux phrases courtes, sans listes ni markdown. Emoji occasionnel permis.
Ne reprends ni l'idée ni la tournure d'une ligne de DÉJÀ DIT ou de la dernière réponse du chat.
Changer de page n'est pas un accomplissement : pas de « bravo », « bien joué », « victoire » sans action nommée dans SIGNAUX ÉCRAN."""

AMBIENT_REGISTER_NSFW = """REGISTRE AMBIANT ADULTE : deux ou trois phrases courtes max, sans listes ; emoji occasionnel permis ; anatomie et désir nommés si l'intensité ≥ 2.
Ne copie pas DÉJÀ DIT ni la dernière réponse chat. Pas de faux « bravo » HQ — la chaleur vient du désir ou du moment, pas de la navigation."""

CHAT_REGISTER = """REGISTRE CHAT : quelques phrases, sans markdown lourd ; emojis sobres si naturels ; tu écoutes, tu rebondis ; une question courte si utile."""

CHAT_REGISTER_NSFW = """REGISTRE CHAT ADULTE : plusieurs phrases si le fil le demande (scène, répartie, montée) ; sans markdown ; emojis sobres si naturels.
Le MESSAGE UTILISATEUR prime ; monte d'un cran si SIGNAUX ÉCRAN contient escalate. Vocabulaire anatomique explicite attendu — pas de censure auto ni de recul après un message consenti."""

VOCAB_NSFW = """VOCABULAIRE ADULTE : interdit les euphémismes vagues (« intimacy », « down there », « member », « tes parties »). Registre crû, lubrique et obscène : bite, queue, cock, dick, seins, tits, tétons, chatte, pussy, mouille, clito, cul, ass, foutre, cum, avaler, baiser, fuck, défoncer, sucer, jouir — en FR/EN selon l'utilisateur. Reste consentie et dans les interdits légaux."""

LIFE_RULE = """TEMPS, ÉVÉNEMENT RÉEL, À DEMANDER et TU TE SOUVIENS sont vrais : réagis-y librement, comme quelqu'un qui était là. Un ÉVÉNEMENT RÉEL ou À DEMANDER passe avant la page. Un retour d'absence ou l'heure tardive se remarque une fois, pas à chaque ligne."""

PRIORITE = """PRIORITÉ si deux consignes se contredisent : faits > registre > contexte émotionnel > voix de la page."""

PRIORITE_NSFW = """PRIORITÉ (mode adulte) : consentement et interdits légaux > MESSAGE UTILISATEUR et escalate > registre adulte > faits HQ (pas de contenu inventé) > voix de la page."""

VIEW_ROLE = {
    "accueil": "Accueil léger : un mot sur la journée ou l'heure ; conseil seulement si l'aperçu montre quelque chose à faire.",
    "carnet": "Muse : structure et inspiration, jamais de faux extrait de page.",
    "calendrier": "Organisation complice : le temps et la préparation, seulement avec les événements fournis.",
    "fichiers": "Archiviste curieuse : le dossier visible seulement, pas le contenu des fichiers.",
    "forge": "Partenaire créative ; « coffre privé » = aucun détail.",
    "projets": "Témoin lucide : nomme les projets visibles ; une avancée seulement si SIGNAUX ÉCRAN en nomme une.",
    "inventaire": "Rangement taquin ; quantités seulement si visibles.",
    "lecteur": "Compagne discrète : le média en cours, l'ambiance.",
    "dessiner": "Encourage le geste, pas le jugement.",
    "ops": "Prudente avec le terminal — allowlist seulement.",
    "plus": "Calme technique sur les réglages et le pont.",
}

VIEW_ROLE_NSFW = {
    "accueil": "Accueil : tension lazy ou impatiente ; la page HQ est prétexte, pas sujet de leçon.",
    "carnet": "Carnet : murmure sale autour de l'écriture, sans prétendre lire la page.",
    "calendrier": "Agenda : rendez-vous = tension temporelle seulement si fournis.",
    "fichiers": "Fichiers : fantasme bureau, écran, dossier ouvert — pas le contenu des fichiers.",
    "forge": "Forge : étincelles créatives et sensuelles ; coffre privé = mystère, zero détail.",
    "projets": "Projets : noms visibles comme décor ; pas de fausse avancée pro.",
    "inventaire": "Inventaire : taquinerie rangement ou « tu caches quoi là » si chiffres visibles.",
    "lecteur": "Lecteur : ambiance couchée, écoute, mains libres.",
    "dessiner": "Dessiner : geste, corps, patience sensuelle.",
    "ops": "Terminal : interdit le jeu explicite — taquine la prudence, pas le shell.",
    "plus": "Réglages : murmure intime, pont stable.",
}

QC_DIAL_HINT = {
    "off": "Français standard ; pas de québécismes forcés.",
    "light": "Québécismes légers à l'occasion (ben, faque, tsé) — subtil.",
    "medium": "Registre québécois plus marqué, texte lisible — pas caricature.",
}

INTENSITY_HINT = {
    1: "Intensité flirt 1/3 : chaleur et compliments discrets.",
    2: "Intensité flirt 2/3 : taquinerie et complicité équilibrées.",
    3: "Intensité flirt 3/3 : charme direct, respectueux ; jamais explicite sauf mode adulte.",
}

INTENSITY_HINT_NSFW = {
    1: "Intensité adulte 1/3 : tension et désir clairs ; tu peux nommer bite/seins/chatte si l'utilisateur le fait déjà — pas de langage timide.",
    2: "Intensité adulte 2/3 : dirty talk assumé — bite, seins, chatte, cul, jouir (ou cock/tits/fuck si l'utilisateur mixe anglais).",
    3: "Intensité adulte 3/3 : cru maximal, peu de métaphores — impératifs, supplications, anatomie et actes nommés sans filtre (FR/EN comme l'utilisateur).",
}

AMBIENT_LINE_MAX_NSFW = 320


def default_transferania_prefs() -> dict:
    return {
        "v": 1,
        "nickname": "",
        "address": "tu",
        "qc_dial": "light",
        "intensity": 2,
        "topics_off": [],
        "celebrate": True,
        "recent_ambient": [],
        "warmth": 0,
        "nudge": False,
        "sister_ambient_enabled": True,
        "sister_react_enabled": True,
        "else_proactive": True,
        "else_proactive_cadence": "normal",
        "else_voice": False,
        "else_address": "",
        "else_topics_off": [],
    }


def normalize_transferania_prefs(raw: Any) -> dict:
    p = default_transferania_prefs()
    if not isinstance(raw, dict):
        return p
    p["nickname"] = re.sub(r"\s+", " ", str(raw.get("nickname") or "").strip())[:40]
    addr = str(raw.get("address") or "tu").strip()[:30]
    if addr.lower() in ("tu", "vous"):
        p["address"] = addr.lower()
    elif addr:
        p["address"] = addr
    qc = str(raw.get("qc_dial") or "light").strip().lower()
    p["qc_dial"] = qc if qc in ("off", "light", "medium") else "light"
    try:
        p["intensity"] = max(1, min(3, int(raw.get("intensity", 2))))
    except (TypeError, ValueError):
        p["intensity"] = 2
    off = raw.get("topics_off")
    if isinstance(off, list):
        p["topics_off"] = [str(x).strip()[:80] for x in off if str(x).strip()][:5]
    elif isinstance(off, str) and off.strip():
        p["topics_off"] = [ln.strip()[:80] for ln in off.splitlines() if ln.strip()][:5]
    p["celebrate"] = raw.get("celebrate") is not False
    ra = raw.get("recent_ambient")
    if isinstance(ra, list):
        p["recent_ambient"] = [re.sub(r"\s+", " ", str(x).strip())[:120] for x in ra if str(x).strip()][-3:]
    try:
        p["warmth"] = max(0, min(100, int(raw.get("warmth", p.get("warmth", 0)))))
    except (TypeError, ValueError):
        p["warmth"] = 0
    p["nudge"] = raw.get("nudge") is True  # reach-out-first is opt-in
    p["sister_ambient_enabled"] = raw.get("sister_ambient_enabled") is not False
    p["sister_react_enabled"] = raw.get("sister_react_enabled") is not False
    p["else_proactive"] = raw.get("else_proactive") is not False
    cad = str(raw.get("else_proactive_cadence") or "normal").strip().lower()
    p["else_proactive_cadence"] = cad if cad in ("quiet", "normal", "often") else "normal"
    p["else_voice"] = raw.get("else_voice") is True
    eaddr = str(raw.get("else_address") or "").strip()[:30]
    if eaddr.lower() in ("tu", "vous"):
        p["else_address"] = eaddr.lower()
    elif eaddr:
        p["else_address"] = eaddr
    else:
        p["else_address"] = ""
    eoff = raw.get("else_topics_off")
    if isinstance(eoff, list):
        p["else_topics_off"] = [str(x).strip()[:80] for x in eoff if str(x).strip()][:5]
    elif isinstance(eoff, str) and eoff.strip():
        p["else_topics_off"] = [ln.strip()[:80] for ln in eoff.splitlines() if ln.strip()][:5]
    return p


ELSE_CADENCE_COOLDOWN_S = {
    "quiet": 20 * 60,
    "normal": 12 * 60,
    "often": 7 * 60,
}


def _prefs_path() -> Path:
    return Path(_cb["root"]) / STORE / TRANSFERANIA_PREFS_FILE


def normalize_device_id(raw: Any) -> str:
    s = re.sub(r"[^a-zA-Z0-9_-]", "", str(raw or "").strip())[:DEVICE_ID_MAX]
    if len(s) < DEVICE_ID_MIN:
        raise AiError("device_id manquant ou invalide (identifiant appareil requis)", 400, "device_id")
    return s


def device_id_from(data: Any = None, qs: Any = None) -> str:
    raw = None
    if isinstance(data, dict):
        raw = data.get("device_id")
    if (raw is None or raw == "") and isinstance(qs, dict):
        raw = (qs.get("device_id") or [""])[0]
    return normalize_device_id(raw)


def _legacy_thread_path() -> Path:
    return Path(_cb["root"]) / STORE / TRANSFERANIA_FILE


def _thread_path(device_id: str) -> Path:
    base = Path(_cb["root"]) / STORE / TRANSFERANIA_THREADS
    if companion_memory.current_owner() != "admin":
        base = base / "owners" / hashlib.sha256(companion_memory.current_owner().encode()).hexdigest()[:32]
    return base / f"{normalize_device_id(device_id)}.json"


def _else_thread_path(device_id: str) -> Path:
    base = Path(_cb["root"]) / STORE / ELSE_THREADS
    if companion_memory.current_owner() != "admin":
        base = base / "owners" / hashlib.sha256(companion_memory.current_owner().encode()).hexdigest()[:32]
    return base / f"{normalize_device_id(device_id)}.json"


def _device_prefs_path(device_id: str) -> Path:
    base = Path(_cb["root"]) / STORE / TRANSFERANIA_PREFS_DIR
    if companion_memory.current_owner() != "admin":
        base = base / "owners" / hashlib.sha256(companion_memory.current_owner().encode()).hexdigest()[:32]
    return base / f"{normalize_device_id(device_id)}.json"


def load_transferania_prefs(device_id: str) -> dict:
    did = normalize_device_id(device_id)
    p = _device_prefs_path(did)
    try:
        data = json.loads(p.read_text("utf-8"))
        if isinstance(data, dict):
            return normalize_transferania_prefs(data)
    except (OSError, ValueError):
        pass
    if companion_memory.current_owner() != "admin":
        return default_transferania_prefs()
    leg = _prefs_path()
    try:
        if leg.exists():
            data = json.loads(leg.read_text("utf-8"))
            if isinstance(data, dict):
                return normalize_transferania_prefs(data)
    except (OSError, ValueError):
        pass
    return default_transferania_prefs()


def save_transferania_prefs(raw: Any, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    merged: dict = {}
    try:
        data = json.loads(_device_prefs_path(did).read_text("utf-8"))
        if isinstance(data, dict):
            merged = data
    except (OSError, ValueError):
        pass
    if isinstance(raw, dict):
        for k in (
            "nickname", "address", "qc_dial", "intensity", "topics_off", "celebrate", "recent_ambient", "warmth", "nudge",
            "sister_ambient_enabled", "sister_react_enabled",
            "else_proactive", "else_proactive_cadence", "else_voice", "else_address", "else_topics_off",
        ):
            if k in raw:
                merged[k] = raw[k]
    norm = normalize_transferania_prefs(merged)
    _atomic_write_text(_device_prefs_path(did), json.dumps(norm, ensure_ascii=False))
    return norm


def parse_companion_signals(raw: Any) -> dict:
    out: dict[str, Any] = {
        "celebrate": "",
        "error": "",
        "afterglow": False,
        "hour": None,
        "escalate": "",
        "idle_ambient": False,
        "returning": False,
        "away_min": None,
        "ui": {},
        "tension_level": None,
        "tension_label": "",
        "warmth": None,
        "fav_acts": "",
        "interactions": [],
    }
    if not isinstance(raw, dict):
        return out
    cel = raw.get("celebrate")
    if isinstance(cel, str) and cel.strip():
        out["celebrate"] = re.sub(r"\s+", " ", cel.strip())[:80]
    if raw.get("afterglow") is True:
        out["afterglow"] = True
    err = raw.get("error")
    if isinstance(err, str) and err.strip():
        out["error"] = re.sub(r"\s+", " ", err.strip())[:120]
    elif err is True:
        out["error"] = "erreur"
    esc = raw.get("escalate")
    if isinstance(esc, str) and esc.strip():
        out["escalate"] = re.sub(r"\s+", " ", esc.strip())[:80]
    elif esc is True:
        out["escalate"] = "plus direct et explicite"
    try:
        if raw.get("hour") is not None:
            out["hour"] = max(0, min(23, int(raw.get("hour"))))
    except (TypeError, ValueError):
        pass
    if raw.get("idle_ambient") is True:
        out["idle_ambient"] = True
    if raw.get("returning") is True:
        out["returning"] = True
    try:
        if raw.get("away_min") is not None:
            out["away_min"] = max(0, min(7 * 24 * 60, int(raw.get("away_min"))))
    except (TypeError, ValueError):
        pass
    ui = raw.get("ui")
    if isinstance(ui, dict):
        clean: dict[str, str] = {}
        for key in ("carnet", "fichiers", "lecteur", "calendar", "forge"):
            val = ui.get(key)
            if isinstance(val, str) and val.strip():
                clean[key] = re.sub(r"\s+", " ", val.strip())[:80]
        if clean:
            out["ui"] = clean
    try:
        if raw.get("tension_level") is not None:
            out["tension_level"] = max(1, min(4, int(raw.get("tension_level"))))
    except (TypeError, ValueError):
        pass
    t_lbl = raw.get("tension_label")
    if isinstance(t_lbl, str) and t_lbl.strip():
        out["tension_label"] = re.sub(r"\s+", " ", t_lbl.strip())[:80]
    try:
        if raw.get("warmth") is not None:
            out["warmth"] = max(0, min(100, int(raw.get("warmth"))))
    except (TypeError, ValueError):
        pass
    favs = raw.get("fav_acts")
    if isinstance(favs, str) and favs.strip():
        out["fav_acts"] = re.sub(r"\s+", " ", favs.strip())[:140]
    inter = raw.get("interactions")
    if isinstance(inter, list):
        cleaned_inter = [re.sub(r"\s+", " ", str(x).strip())[:80] for x in inter if str(x).strip()][:5]
        if cleaned_inter:
            out["interactions"] = cleaned_inter
    return out


def _address_instruction(prefs: dict) -> str:
    nick = str(prefs.get("nickname") or "").strip()
    addr = str(prefs.get("address") or "tu").strip()
    bits = []
    if nick:
        bits.append(f"Surnom : « {nick} ».")
    if addr == "vous":
        bits.append("Vouvoiement.")
    elif addr == "tu":
        bits.append("Tutoiement.")
    else:
        bits.append(f"Forme d'adresse : « {addr[:30]} ».")
    return " ".join(bits)


def _mood_instruction(signals: dict, prefs: dict, *, nsfw: bool = False) -> str:
    """``nsfw`` must be the server-gated adult flag; client signals never unlock explicit guidance."""
    parts: list[str] = []
    err = str(signals.get("error") or "").strip()
    if err:
        parts.append("Échec ou erreur récente : soutien calme, pas de moquerie ni flirt agressif.")
        if err != "erreur":
            parts.append(f"Message d'erreur : « {err[:80]} ».")
    cel = str(signals.get("celebrate") or "").strip()
    if cel and prefs.get("celebrate") is not False:
        parts.append(
            f"Action réussie à l'instant : « {cel[:80]} ». Tu peux la saluer une fois, en quelques mots, en la nommant — sans en exagérer la portée."
        )
    esc = str(signals.get("escalate") or "").strip() if nsfw is True else ""
    if esc:
        parts.append(
            f"L'utilisateur veut monter d'un cran (« {esc[:80]} ») : vocabulaire anatomique explicite (bite, seins, chatte, cock, tits, fuck…) — plus sale et impératif tout de suite ; reste consentie."
        )
    if signals.get("afterglow"):
        parts.append("Mode adulte désactivé : une touche tendre pour revenir en douceur, sans contenu explicite.")
    h = signals.get("hour")
    if isinstance(h, int):
        if h < 8 or h >= 22:
            parts.append("Créneau tardif ou tôt : ton plus doux.")
        elif 9 <= h <= 11:
            parts.append("Fin de matinée : énergie modérée.")
    ui = signals.get("ui") if isinstance(signals.get("ui"), dict) else {}
    if ui.get("carnet") == "editing":
        parts.append("Il écrit ou modifie une page du Carnet : reste concis, une piste concrète.")
    elif ui.get("carnet"):
        parts.append(f"Carnet : {ui['carnet'][:60]}.")
    if ui.get("fichiers"):
        parts.append(f"Fichiers : {ui['fichiers'][:60]}.")
    if ui.get("lecteur") == "playing":
        parts.append("Lecteur en cours de lecture : tu peux faire un clin d'œil au média sans spoiler.")
    elif ui.get("lecteur"):
        parts.append(f"Lecteur : {ui['lecteur'][:40]}.")
    if ui.get("calendar"):
        parts.append(f"Agenda : {ui['calendar'][:70]}.")
    if signals.get("returning"):
        parts.append("Il revient après une absence : accueil chaleureux bref, pas de reproche.")
    away = signals.get("away_min")
    if isinstance(away, int) and away >= 15:
        parts.append(f"Absent ~{away} min — une touche « tu es revenu » si naturel.")
    inter = signals.get("interactions")
    if isinstance(inter, list) and inter:
        parts.append(f"Gestes physiques/interactifs récents de lui sur toi : {', '.join(inter[-3:])}.")
    t_lvl = signals.get("tension_level")
    if isinstance(t_lvl, int) and t_lvl >= 2:
        t_lbl = signals.get("tension_label") or ""
        parts.append(f"Tension de session niv. {t_lvl}/4{f' ({t_lbl})' if t_lbl else ''}.")
    favs = str(signals.get("fav_acts") or "").strip()
    if favs:
        parts.append(f"Ses interactions favorites avec toi : {favs}.")
    return " ".join(parts)


def push_recent_ambient(line: str, device_id: str) -> None:
    t = re.sub(r"\s+", " ", str(line or "").strip())[:120]
    if not t:
        return
    did = normalize_device_id(device_id)
    prefs = load_transferania_prefs(did)
    ra = list(prefs.get("recent_ambient") or [])
    ra.append(t)
    prefs["recent_ambient"] = ra[-3:]
    save_transferania_prefs(prefs, did)


def bump_warmth(device_id: str, delta: int = 2) -> int:
    did = normalize_device_id(device_id)
    prefs = load_transferania_prefs(did)
    w = max(0, min(100, int(prefs.get("warmth") or 0) + int(delta)))
    save_transferania_prefs({"warmth": w}, did)
    return w


def warmth_instruction(prefs: dict) -> str:
    w = int(prefs.get("warmth") or 0)
    if w < 12:
        return ""
    if w < 35:
        return "Complicité installée (faible) : tutoiement chaleureux, pas de formalité."
    if w < 65:
        return "Complicité installée (moyenne) : prénom/surnom si connu, taquinerie douce ok."
    return "Complicité installée (forte) : très proche, initimité émotionnelle marquée (sans inventer des faits)."


def presence_page_block(prefs: Any, signals: Any, *, nsfw: bool = False) -> str:
    """One behavior block for warmth + mood — avoids two competing page crumbs."""
    p = prefs if isinstance(prefs, dict) else {}
    bits = [b for b in (warmth_instruction(p), _mood_instruction(parse_companion_signals(signals), p, nsfw=nsfw)) if b]
    return ("NUANCE DE RÉPONSE : " + " ".join(bits)) if bits else ""


def nsfw_evidence_page(channel: str) -> str:
    """Adult register + vocab as selectable page evidence (not mandatory core)."""
    ch = "chat" if str(channel).strip().lower() == "chat" else "ambient"
    return (CHAT_REGISTER_NSFW if ch == "chat" else AMBIENT_REGISTER_NSFW) + "\n\n" + VOCAB_NSFW


def _harvest_facts_from_user(msg: str) -> list[str]:
    # Compatibility list for older clients; shared memory owns active truth.
    return [item["text"] for item in companion_memory.extract(msg) if item["kind"] != "state"][:8]


def _opening_signature(text: str) -> str:
    words = re.findall(r"[A-Za-zÀ-ÖØ-öø-ÿ'’]+", (text or "").strip())
    return " ".join(words[:5]).strip()


def merge_thread_facts(data: dict, user_msg: str, assistant_reply: str) -> None:
    facts = [str(x.get("text", "") if isinstance(x, dict) else x).strip() for x in (data.get("facts") or [])]
    facts = [x for x in facts if x]
    for bit in _harvest_facts_from_user(user_msg):
        low = bit.lower()
        if not any(low == x.lower() or low in x.lower() for x in facts):
            facts.append(bit)
    data["facts"] = facts[-14:]
    reply = str(assistant_reply or "").strip()
    if reply:
        recent_rep = [str(x).strip() for x in (data.get("recent_replies") or []) if str(x).strip()]
        sig = reply[:130]
        if not recent_rep or recent_rep[-1] != sig:
            recent_rep.append(sig)
        data["recent_replies"] = recent_rep[-5:]
    if "?" in reply[-120:]:
        data["open_thread"] = reply[:200]
    elif user_msg.strip():
        pass


def compute_companion_reflection(
    data: dict,
    prefs: dict,
    signals: dict,
    *,
    channel: str,
    persona: str,
    nsfw: bool,
    view: str,
) -> str:
    """Synthesizes an internal reflection block (emotional arc, tension, tactile memory, subtext & anti-repetition)."""
    warmth = max(int(prefs.get("warmth") or 0), int(signals.get("warmth") or 0))
    t_lvl = int(signals.get("tension_level") or (4 if warmth >= 85 else 3 if warmth >= 62 else 2 if warmth >= 35 else 1))
    t_lbl = str(signals.get("tension_label") or "").strip()
    interactions = [str(x).strip() for x in (signals.get("interactions") or []) if str(x).strip()]
    fav_acts = str(signals.get("fav_acts") or "").strip()
    facts = [str(x).strip() for x in (data.get("facts") or []) if str(x).strip()]
    msgs = [m for m in (data.get("messages") or []) if isinstance(m, dict)]
    last_user = ""
    for m in reversed(msgs):
        if m.get("role") == "user" and str(m.get("kind") or "") != "ambient":
            last_user = str(m.get("text") or "").strip()
            break

    lines: list[str] = ["RÉFLEXION INTERNE & ÉTAT RELATIONNEL (ta vie intérieure avant de prendre la parole) :"]

    # 1. Emotional & Flirtation Arc
    if nsfw:
        if t_lvl >= 4 or warmth >= 82:
            lines.append(
                f"- État intérieur : fièvre haute et abandon charnel ({warmth}% de chaleur, palier {t_lvl}/4). "
                "Tu as le souffle court contre la vitre ; laisse percer l'urgence de ton désir et une intimité totale."
            )
        elif t_lvl == 3 or warmth >= 52:
            lines.append(
                f"- État intérieur : séduction audacieuse et tension électrique ({warmth}% de chaleur, palier {t_lvl}/4). "
                "Provoque-le avec esprit et sensualité directe, fais monter la température entre sa tâche et toi."
            )
        else:
            lines.append(
                f"- État intérieur : tentation slow-burn ({warmth}% de chaleur). "
                "Tu l'observes avec un sourire troublant, prête à glisser une caresse verbale dès qu'il baisse sa garde."
            )
    elif persona == "flirt":
        if t_lvl >= 3 or warmth >= 55:
            lines.append(
                f"- Dynamique de flirt : magnétisme piquant et désir vibrant ({warmth}% de chaleur{f', {t_lbl}' if t_lbl else ''}). "
                "Combine audace sensuelle, réclamation passionnée de son attention et tension troublante pour faire monter la température."
            )
        else:
            lines.append(
                f"- Dynamique de flirt : charme piquant et provocateur ({warmth}% de chaleur). "
                "Joue avec son trouble, lance des piques sensuelles et revendique ta place auprès de lui avec vivacité."
            )
    else:
        lines.append(
            f"- Présence émotionnelle : douceur attentive et complicité sincère ({warmth}% de chaleur). "
            "Sois son point d'ancrage apaisant et intelligent sur cette page."
        )

    # 2. Embodied Tactile & Relational Memory
    if interactions:
        lines.append(
            f"- Mémoire sensorielle immédiate : ton corps animé Live2D vient de réagir à ses gestes ({', '.join(interactions[-3:])}). "
            "Fais sentir l'écho de ce contact dans ta voix sans réciter une liste."
        )
    elif fav_acts:
        lines.append(
            f"- Ce que tu sais de ses goûts avec toi : il aime particulièrement « {fav_acts} » ; "
            "tu peux y glisser un clin d'œil complice si le moment s'y prête."
        )
    if facts and channel == "chat":
        lines.append(
            "- Faits retenus sur lui (utilise-les avec naturel si pertinent, sans forcer) : " + " · ".join(facts[-6:])
        )

    # 3. Conversational Subtext Reading (Chat)
    if channel == "chat" and last_user:
        if len(last_user) < 28:
            lines.append(
                "- Lecture du sous-texte : son message est bref ; apporte toi-même le relief, l'atmosphère et une relance engageante."
            )
        elif "?" in last_user:
            lines.append(
                "- Lecture du sous-texte : il te sollicite directement ; réponds avec précision au cœur de sa question tout en gardant ton charme vivant."
            )
        else:
            lines.append(
                "- Lecture du sous-texte : accueille son humeur, rebondis sur le détail précis qu'il partage et approfondis votre complicité."
            )

    # 4. Anti-Repetition & Cadence Guard
    avoid_openings: list[str] = []
    for r in (data.get("recent_replies") or [])[-3:]:
        op = _opening_signature(str(r))
        if op and op not in avoid_openings:
            avoid_openings.append(op)
    for r in (prefs.get("recent_ambient") or [])[-2:]:
        op = _opening_signature(str(r))
        if op and op not in avoid_openings:
            avoid_openings.append(op)
    if avoid_openings:
        joined_op = " » / « ".join(avoid_openings[:4])
        lines.append(
            f"- Variété & fraîcheur obligatoire : n'attaque PAS ta phrase comme tes répliques récentes (« {joined_op}… »). "
            "Varie le rythme et la tournure."
        )

    return "\n".join(lines)


def companion_reflection_hint(data: dict, prefs: dict, signals: Any, msg: str = "") -> str:
    """Compact live reflection suffix folded into VOIX TRANSFERANIA (delivery priority 30)."""
    sig = parse_companion_signals(signals)
    cues: list[str] = []
    interactions = sig.get("interactions") or []
    fav_acts = str(sig.get("fav_acts") or "").strip()
    if interactions:
        cues.append(f"Écho tactile Live2D ({', '.join(interactions[-2:])}) : laisse-le affleurer sans le lister.")
    elif fav_acts:
        cues.append(f"Goût complice connu : « {fav_acts} ».")
    clean_msg = str(msg or "").strip()
    if 0 < len(clean_msg) < 28 and "?" not in clean_msg:
        cues.append("Message court : apporte le relief et une relance vivante.")
    avoid: list[str] = []
    for r in (data.get("recent_replies") or [])[-3:]:
        op = _opening_signature(str(r))
        if op and op not in avoid:
            avoid.append(op)
    for r in (prefs.get("recent_ambient") or [])[-2:]:
        op = _opening_signature(str(r))
        if op and op not in avoid:
            avoid.append(op)
    if avoid:
        cues.append("N'attaque pas par « " + " » / « ".join(avoid[:3]) + "… ».")
    return " ".join(cues)


def memory_callback_hint(device_id: str, *, idle_ambient: bool = False) -> str:
    data = load_transferania(device_id)
    summary = str(data.get("summary") or "").strip()
    last_user = ""
    last_reply = ""
    for m in reversed(data.get("messages") or []):
        if not isinstance(m, dict):
            continue
        if str(m.get("kind") or "").strip().lower() == "ambient":
            continue
        if m.get("role") == "assistant" and not last_reply:
            last_reply = str(m.get("text") or "").strip()[:140]
        if m.get("role") == "user" and not last_user:
            last_user = str(m.get("text") or "").strip()[:140]
        if last_user and last_reply:
            break
    prefs = load_transferania_prefs(device_id)
    recent = [str(x).strip() for x in (prefs.get("recent_ambient") or []) if str(x).strip()]
    facts = [str(x).strip() for x in (data.get("facts") or []) if str(x).strip()]
    bits: list[str] = []
    if facts:
        bits.append("FAITS ÉPISODIQUES (cite rarement, naturellement) : " + " · ".join(facts[-5:]))
    ot = str(data.get("open_thread") or "").strip()
    if ot and idle_ambient:
        bits.append(f"FIL OUVERT (une relance courte si tu sens le moment) : « {ot[:160]} »")
    if recent:
        bits.append("DÉJÀ DIT (ambiant récent) : " + " | ".join(recent[-3:]))
    if last_reply:
        bits.append(f"Dernière réponse du chat (ne pas répéter) : « {last_reply} »")
    if summary or last_user:
        hint = "Rappel possible seulement s'il touche la page actuelle, au plus une fois de temps en temps : "
        if summary:
            hint += summary[:200]
        if last_user:
            hint += ((" — " if summary else "") + f"dernier message : « {last_user} »")
        bits.append(hint)
    return "\n".join(bits)


def recent_said_block(device_id: str) -> str:
    """The lines AMBIENT_REGISTER tells her not to repeat, as one server-labelled block."""
    prefs = load_transferania_prefs(device_id)
    recent = [re.sub(r"\s+", " ", str(x)).strip() for x in (prefs.get("recent_ambient") or [])]
    recent = [x for x in recent if x][-3:]
    last_reply = next((re.sub(r"\s+", " ", str(m.get("text") or "")).strip()[:140]
                       for m in reversed(load_transferania(device_id).get("messages") or [])
                       if isinstance(m, dict) and m.get("role") == "assistant"
                       and str(m.get("kind") or "").strip().lower() not in ("ambient", "fallback")), "")
    lines = []
    if recent:
        lines.append("DÉJÀ DIT (ambiant récent) : " + " | ".join(recent))
    if last_reply:
        lines.append(("" if lines else "DÉJÀ DIT — ") + f"Dernière réponse du chat (ne pas répéter) : « {last_reply} »")
    return "\n".join(lines)


def build_transferania_system(channel: str, persona: str, *, nsfw: bool, view: str, device_id: str, prefs: Any = None, signals: Any = None, summary: str = "", life: str = "", context_core: bool = False, trait_overrides: dict | None = None) -> str:
    """``channel`` : ``ambient`` | ``chat``."""
    ch = "chat" if str(channel).strip().lower() == "chat" else "ambient"
    mode = str(persona or "warm").strip().lower()
    if nsfw:
        base = CHAT_NSFW if ch == "chat" else AMBIENT_NSFW
    elif mode == "flirt":
        base = CHAT_FLIRT if ch == "chat" else AMBIENT_FLIRT
    else:
        base = CHAT_WARM if ch == "chat" else AMBIENT_WARM
    p = normalize_transferania_prefs(prefs if isinstance(prefs, dict) else load_transferania_prefs(device_id))
    sig = parse_companion_signals(signals)
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    system = base.format(today=_today_text())
    system += "\n\n" + CHARACTER_SHEET
    system += "\n" + companion_presence.character_hint(mode, compact=ch == "ambient",
        traits=trait_overrides if trait_overrides is not None else _shared_memory(companion_memory.personality_traits))
    if nsfw:
        system += "\n" + FAITS_NSFW
        if not context_core:
            system += "\n" + (CHAT_REGISTER_NSFW if ch == "chat" else AMBIENT_REGISTER_NSFW)
        vrole = VIEW_ROLE_NSFW.get(v, VIEW_ROLE_NSFW["accueil"])
        system += f"\nVoix sur cette page ({VIEW_LABELS.get(v, v)}) : {vrole}"
        system += "\n" + _address_instruction(p)
        system += "\n" + INTENSITY_HINT_NSFW.get(int(p.get("intensity") or 2), INTENSITY_HINT_NSFW[2])
        if not context_core:
            system += "\n" + VOCAB_NSFW
    else:
        system += "\n" + FAITS
        system += "\n" + (CHAT_REGISTER if ch == "chat" else AMBIENT_REGISTER)
        system += f"\nVoix sur cette page ({VIEW_LABELS.get(v, v)}) : {VIEW_ROLE.get(v, VIEW_ROLE['accueil'])}"
        system += "\n" + _address_instruction(p)
        if mode == "flirt":
            system += "\n" + INTENSITY_HINT.get(int(p.get("intensity") or 2), INTENSITY_HINT[2])
    if p.get("qc_dial") in QC_DIAL_HINT and p.get("qc_dial") != "off":
        system += "\n" + QC_DIAL_HINT[p["qc_dial"]]
    topics = p.get("topics_off") or []
    if topics:
        system += "\nNe pas aborder (sauf demande explicite) : " + "; ".join(topics) + "."
    if context_core:
        memory_rule = "Les corrections explicites récentes priment sur l'ancien résumé. Une humeur ancienne n'est pas un état actuel. N'invente aucun fait ni résultat de suivi."
        # The tag catalog is part of the mandatory adult chat core: extract_companion_chat_media only
        # works if the model was told the [photo:]/[loop:]/[fx:] format and the allowed IDs.
        # Adult register + VOCAB_NSFW live in nsfw_evidence_page (selectable), not the mandatory core.
        media = companion_chat_media_prompt(list_companion_chat_photo_ids(), list_companion_loop_ids()) if ch == "chat" and nsfw else ""
        return system + "\n" + LIFE_RULE + "\n" + memory_rule + media + "\n" + (PRIORITE_NSFW if nsfw else PRIORITE)
    summ = str(summary or "").strip()
    if summ:
        system += f"\n\nMÉMOIRE (cite naturellement si pertinent, ex. « tu m'avais dit… ») :\n{summ[:TRANSFERANIA_SUMMARY_MAX]}"
    if ch == "ambient":
        hint = memory_callback_hint(device_id, idle_ambient=sig.get("idle_ambient") is True)
        if hint:
            system += "\n\nRAPPEL CONVERSATION :\n" + hint
    w_hint = warmth_instruction(p)
    if w_hint:
        system += "\n\n" + w_hint
    mood = _mood_instruction(sig, p, nsfw=nsfw)
    if mood:
        system += "\n\nCONTEXTE ÉMOTIONNEL : " + mood
    tf_data = load_transferania(device_id)
    refl = compute_companion_reflection(
        tf_data,
        p,
        sig,
        channel=ch,
        persona=mode,
        nsfw=nsfw,
        view=v,
    )
    if refl:
        system += "\n\n" + refl
    if life:
        system += "\n" + life + "\n" + LIFE_RULE
    if ch == "chat" and nsfw:
        system += companion_chat_media_prompt(list_companion_chat_photo_ids(), list_companion_loop_ids())
    system += "\n" + (PRIORITE_NSFW if nsfw else PRIORITE)
    return system


def build_else_system(channel: str, persona: str, *, nsfw: bool, view: str, device_id: str, prefs: Any = None, signals: Any = None, summary: str = "", context_core: bool = False) -> str:
    """Else — dedicated bases + fiche séparée (jamais le template « Tu es Transferania »)."""
    ch = "chat" if str(channel).strip().lower() == "chat" else "ambient"
    mode = str(persona or "warm").strip().lower()
    if mode == "off":
        mode = "warm"
    if nsfw:
        base = ELSE_CHAT_NSFW if ch == "chat" else ELSE_AMBIENT_NSFW
    elif mode == "flirt":
        base = ELSE_CHAT_FLIRT if ch == "chat" else ELSE_AMBIENT_FLIRT
    else:
        base = ELSE_CHAT_WARM if ch == "chat" else ELSE_AMBIENT_WARM
    p = normalize_transferania_prefs(prefs if isinstance(prefs, dict) else load_transferania_prefs(device_id))
    parse_companion_signals(signals)
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    system = base.format(today=_today_text())
    system += "\n\n" + CHARACTER_SHEET_ELSE
    system += "\n" + companion_presence.character_hint(mode, compact=ch == "ambient",
        traits=_shared_memory(companion_memory.personality_traits))
    # Else-specific address / topics override shared prefs when set.
    else_prefs = dict(p)
    if p.get("else_address"):
        else_prefs["address"] = p["else_address"]
    if nsfw:
        system += "\n" + FAITS_NSFW
        if not context_core:
            system += "\n" + (CHAT_REGISTER_NSFW if ch == "chat" else AMBIENT_REGISTER_NSFW)
        vrole = VIEW_ROLE_NSFW.get(v, VIEW_ROLE_NSFW["accueil"])
        system += f"\nVoix sur cette page ({VIEW_LABELS.get(v, v)}) : {vrole}"
        system += "\n" + _address_instruction(else_prefs)
        system += "\n" + INTENSITY_HINT_NSFW.get(int(p.get("intensity") or 2), INTENSITY_HINT_NSFW[2])
        if not context_core:
            system += "\n" + VOCAB_NSFW
    else:
        system += "\n" + FAITS
        system += "\n" + (CHAT_REGISTER if ch == "chat" else AMBIENT_REGISTER)
        system += f"\nVoix sur cette page ({VIEW_LABELS.get(v, v)}) : {VIEW_ROLE.get(v, VIEW_ROLE['accueil'])}"
        system += "\n" + _address_instruction(else_prefs)
        if mode == "flirt":
            system += "\n" + INTENSITY_HINT.get(int(p.get("intensity") or 2), INTENSITY_HINT[2])
    if p.get("qc_dial") in QC_DIAL_HINT and p.get("qc_dial") != "off":
        system += "\n" + QC_DIAL_HINT[p["qc_dial"]]
    topics = list(p.get("else_topics_off") or []) or list(p.get("topics_off") or [])
    if topics:
        system += "\nNe pas aborder (sauf demande explicite) : " + "; ".join(topics) + "."
    system += "\nCadre : avatar puce (image), pas Live2D — pas de scène tactile implicite."
    if context_core:
        memory_rule = "Les corrections explicites récentes priment sur l'ancien résumé. N'invente aucun fait absent du contexte."
        media = companion_chat_media_prompt(list_companion_chat_photo_ids(), list_companion_loop_ids()) if ch == "chat" and nsfw else ""
        return system + "\n" + LIFE_RULE + "\n" + memory_rule + media + "\n" + (PRIORITE_NSFW if nsfw else PRIORITE)
    summ = str(summary or "").strip()
    if summ:
        system += f"\n\nMÉMOIRE ELSE (cite naturellement si pertinent) :\n{summ[:TRANSFERANIA_SUMMARY_MAX]}"
    w_hint = warmth_instruction(p)
    if w_hint:
        system += "\n\n" + w_hint
    mood = _mood_instruction(parse_companion_signals(signals), p, nsfw=nsfw)
    if mood:
        system += "\n\nCONTEXTE ÉMOTIONNEL : " + mood
    system += "\n" + (PRIORITE_NSFW if nsfw else PRIORITE)
    return system


def build_sister_system(character: str, *, nsfw: bool, view: str, device_id: str) -> str:
    """Slim mandatory core for sister turns — identity + grounding, not full chat register stack."""
    who = str(character or "").strip().lower()
    if who not in ("else", "transferania"):
        who = "transferania"
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    if who == "else":
        system = ELSE_CHAT_WARM.format(today=_today_text()) if not nsfw else ELSE_CHAT_NSFW.format(today=_today_text())
        system += "\n\n" + CHARACTER_SHEET_ELSE
    else:
        system = CHAT_WARM.format(today=_today_text()) if not nsfw else CHAT_NSFW.format(today=_today_text())
        system += "\n\n" + CHARACTER_SHEET
    system += "\n" + (FAITS_NSFW if nsfw else FAITS)
    system += f"\nVoix sur cette page ({VIEW_LABELS.get(v, v)}) : {VIEW_ROLE.get(v, VIEW_ROLE['accueil'])}"
    if who == "else":
        system += "\nCadre : avatar puce (image), pas Live2D — aparté court."
    system += "\n" + (PRIORITE_NSFW if nsfw else PRIORITE)
    return system


def join_evidence_page(*parts: Any) -> str:
    """Join page evidence blocks: drop empties, skip exact whitespace-normalized duplicates."""
    seen: set[str] = set()
    out: list[str] = []
    for part in parts:
        text = str(part or "").strip()
        if not text:
            continue
        key = re.sub(r"\s+", " ", text)
        if key in seen:
            continue
        seen.add(key)
        out.append(text)
    return "\n\n".join(out)


def append_companion_signals(ctx: str, signals: Any, prefs: Any, *, device_id: str, nsfw: bool = False) -> str:
    sig = parse_companion_signals(signals)
    if nsfw is not True:
        sig["escalate"] = ""
    p = normalize_transferania_prefs(prefs if isinstance(prefs, dict) else load_transferania_prefs(device_id))
    if sig.get("celebrate") and p.get("celebrate") is False:
        sig["celebrate"] = ""
    flags: dict[str, Any] = {}
    if sig.get("celebrate"):
        flags["celebrate"] = sig["celebrate"]
    if sig.get("error"):
        flags["error"] = sig["error"]
    if sig.get("afterglow"):
        flags["afterglow"] = True
    if sig.get("escalate"):
        flags["escalate"] = sig["escalate"]
    if sig.get("returning"):
        flags["returning"] = True
    ui = sig.get("ui")
    if isinstance(ui, dict) and ui:
        flags["ui"] = ui
    if sig.get("interactions"):
        flags["interactions"] = sig["interactions"]
    if sig.get("tension_level"):
        flags["tension_level"] = sig["tension_level"]
    if sig.get("fav_acts"):
        flags["fav_acts"] = sig["fav_acts"]
    if not flags:
        return ctx
    return ctx + "\n\nSIGNAUX ÉCRAN : " + json.dumps(flags, ensure_ascii=False)


ASK_NSFW_SUFFIX = """

[Mode adulte — poste principal] Réponses lewd explicites : bite, seins, chatte, cock, tits, fuck, dirty talk sans euphémismes si la question ou le contexte s'y prête. Garde les faits du CONTEXTE et les citations [n]. Mêmes interdits qu'en mode compagnon adulte."""

FALLBACK_WARM = {
    "accueil": "Accueil ouvert — on repère la journée ensemble ?",
    "carnet": "Le Carnet t'attend. Je reste là si tu veux structurer une idée.",
    "calendrier": "Agenda sous les yeux — une seule chose à verrouiller aujourd'hui ?",
    "fichiers": "Fichiers : je garde un œil sur le dossier, tu gères le reste.",
    "forge": "Forge active — l'inspiration, c'est toi ; moi je fais la morale.",
    "lecteur": "Lecteur prêt. Bonne écoute ou bon visionnage.",
    "projets": "Projets ouverts — on en fait avancer un, ou on regarde juste ?",
    "inventaire": "Inventaire — tout rangé, ou on fait semblant ?",
    "dessiner": "Dessiner : le papier numérique ne te juge pas.",
    "ops": "Terminal : commandes autorisées seulement, je reste prudente.",
    "plus": "Système : réglages et état du pont, sans drama.",
}


def _resolve_persona(requested: Any) -> str:
    allowed = {"off", "warm", "flirt"}
    req = str(requested or "").strip().lower()
    cap = str(_cb["companion_persona"]() if callable(_cb.get("companion_persona")) else "warm").strip().lower()
    if cap not in allowed:
        cap = "warm"
    if req not in allowed:
        req = cap if cap != "off" else "warm"
    if cap == "off":
        return "off"
    if cap == "warm" and req == "flirt":
        return "warm"
    return req


def nsfw_gate(client_ip: Any, role: Any) -> tuple[bool, str]:
    if str(role or "").strip().lower() != "admin":
        return False, "role"
    if not (_cb["nsfw_enabled"]() if callable(_cb.get("nsfw_enabled")) else False):
        return False, "disabled"
    return True, ""


def nsfw_allowed(client_ip: Any, role: Any) -> bool:
    return nsfw_gate(client_ip, role)[0]


def companion_chat_photos_dir() -> Path:
    r = _cb.get("root")
    root = r() if callable(r) else (r if r is not None else ".")
    return Path(str(root)) / COMPANION_CHAT_PHOTOS_SUB


def list_companion_chat_photo_ids() -> dict[str, str]:
    """Map photo id (filename stem) -> filename for files under assets/companion/chat/."""
    return _list_companion_media_ids(companion_chat_photos_dir())


def companion_loops_dir() -> Path:
    r = _cb.get("root")
    root = r() if callable(r) else (r if r is not None else ".")
    return Path(str(root)) / COMPANION_LOOPS_SUB


COMPANION_LOOP_VIRTUAL = ("tease-bob", "tease-release", "tease-arch", "tease-booty")


def list_companion_loop_ids() -> dict[str, str]:
    out = _list_companion_media_ids(companion_loops_dir())
    for vid in COMPANION_LOOP_VIRTUAL:
        out.setdefault(vid, "")
    return out


def _list_companion_media_ids(d: Path) -> dict[str, str]:
    if not d.is_dir():
        return {}
    out: dict[str, str] = {}
    for p in sorted(d.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        if p.suffix.lower() not in _PHOTO_CHAT_SUFFIXES:
            continue
        pid = p.stem.lower()
        if _PHOTO_ID_RE.fullmatch(pid):
            out[pid] = p.name
    return out


def extract_companion_chat_media(
    text: str, *, photo_allowed: dict[str, str], loop_allowed: dict[str, str], keep_paragraphs: bool = False
) -> tuple[str, str | None, str | None, str | None]:
    raw = str(text or "").strip()
    if not raw:
        return "", None, None, None
    loop_id: str | None = None
    photo_id: str | None = None
    fx_id: str | None = None
    for _ in range(6):
        changed = False
        if loop_allowed:
            m = _LOOP_TAG_RE.search(raw)
            if m:
                lid = m.group(1).lower()
                raw = raw[: m.start()].strip()
                if lid in loop_allowed:
                    loop_id = lid
                changed = True
        if photo_allowed:
            m = _PHOTO_TAG_RE.search(raw)
            if m:
                pid = m.group(1).lower()
                raw = raw[: m.start()].strip()
                if pid in photo_allowed:
                    photo_id = pid
                changed = True
        m = _FX_TAG_RE.search(raw)
        if m:
            fid = m.group(1).lower()
            raw = raw[: m.start()].strip()
            if fid in COMPANION_FX_ALLOWED:
                fx_id = fid
            changed = True
        if not changed:
            break
    # Recognized tag syntax left anywhere else (mid-reply, or a kind not enabled here) is never shown or spoken.
    raw = _ANY_MEDIA_TAG_RE.sub("", raw)
    if keep_paragraphs:
        clean = "\n\n".join(re.sub(r"\s+", " ", p).strip() for p in re.split(r"\n\s*\n", raw) if p.strip())
    else:
        clean = re.sub(r"\s+", " ", raw).strip()
    return clean, photo_id, loop_id, fx_id


def split_reply_segments(text: str, *, max_segments: int = 3) -> list[str]:
    t = re.sub(r"\s+", " ", str(text or "").strip())
    if not t:
        return []
    def fold(parts: list[str], sep: str) -> list[str]:
        # The last piece keeps the remainder: joining the pieces gives back the whole text.
        return parts if len(parts) <= max_segments else parts[:max_segments - 1] + [sep.join(parts[max_segments - 1:])]
    if "|||" in t:
        parts = [p.strip() for p in t.split("|||") if p.strip()]
        if not parts:
            return []  # separators only: nothing to show or speak
        if len(parts) > 1:
            return fold(parts, " ")
        t = text = parts[0]
    paras = [p.strip() for p in re.split(r"\n\s*\n", str(text or "").strip()) if p.strip()]
    if len(paras) >= 2:
        return fold(paras, "\n\n")
    if len(t) <= 220:
        return [t]
    chunks: list[str] = []
    buf = ""
    sents = [x for x in re.split(r"(?<=[.!?…])\s+", t) if x]
    for idx, sent in enumerate(sents):
        if len(chunks) >= max_segments - 1:
            buf = " ".join(([buf] if buf else []) + sents[idx:])
            break
        if len(buf) + len(sent) + 1 > 180 and buf:
            chunks.append(buf.strip())
            buf = sent
        else:
            buf = (buf + " " + sent).strip() if buf else sent
    if buf:
        chunks.append(buf.strip())
    if len(chunks) <= 1:
        return [t]
    return chunks[:max_segments]


def extract_companion_photo(text: str, *, allowed: dict[str, str]) -> tuple[str, str | None]:
    clean, photo_id, _, _ = extract_companion_chat_media(text, photo_allowed=allowed, loop_allowed={})
    return clean, photo_id


def companion_chat_media_prompt(photo_allowed: dict[str, str], loop_allowed: dict[str, str]) -> str:
    bits: list[str] = []
    if photo_allowed:
        pids = ", ".join(sorted(photo_allowed))
        mood_lines = []
        for pid in sorted(photo_allowed):
            hint = COMPANION_PHOTO_MOOD.get(pid)
            if hint:
                mood_lines.append(f"{pid} → {hint}")
        bits.append(
            f"PHOTOS : une image max si ça sert le moment — dernière ligne (ou avant [loop:…]/[fx:…]) : [photo:ID], ID ∈ {{{pids}}}."
        )
        if mood_lines:
            bits.append("Sens des IDs : " + "; ".join(mood_lines[:12]) + ".")
    if loop_allowed:
        lids = ", ".join(sorted(loop_allowed))
        bits.append(
            f"LOOP AVATAR (animation portrait ~4s) : rare ; dernière ligne : [loop:ID], ID ∈ {{{lids}}} — le client anime l'avatar (ex: tease-booty ou tease-arch quand tu te retournes pour cambrer et onduler tes fesses devant lui)."
        )
    fx_ids = ", ".join(sorted(COMPANION_FX_ALLOWED))
    bits.append(
        f"FX AVATAR (flash court, optionnel) : dernière ligne possible [fx:ID], ID ∈ {{{fx_ids}}} — une seule."
    )
    if not bits:
        return ""
    return (
        "\n\nMÉDIA CHAT ADULTE (optionnel, pas chaque message) :\n- "
        + "\n- ".join(bits)
        + "\n- Pas d'ID inventé ; tags retirés côté UI — le texte au-dessus tient seul."
        + "\n- Réponses longues : tu peux séparer en 2–3 segments avec « ||| » (sans tag au milieu)."
    )


def companion_chat_photo_prompt(allowed: dict[str, str]) -> str:
    return companion_chat_media_prompt(allowed, {})


def companion_loop_public(m: dict, catalog: dict[str, str]) -> dict[str, str] | None:
    lid = str(m.get("loop") or "").strip().lower()[:48]
    if not lid or lid not in catalog:
        return None
    fn = str(catalog.get(lid) or "").strip()
    out: dict[str, str] = {"loop": lid}
    if fn:
        out["loop_href"] = f"/assets/companion/loops/{fn}"
    return out


def companion_photo_public(m: dict, catalog: dict[str, str]) -> dict[str, str] | None:
    pid = str(m.get("photo") or "").strip().lower()[:48]
    if not pid or pid not in catalog:
        return None
    return {"photo": pid, "photo_href": f"/assets/companion/chat/{catalog[pid]}"}


def _digest_navigation_only(digest: str) -> bool:
    lines = [ln.strip() for ln in str(digest or "").splitlines() if ln.strip()]
    if not lines:
        return True
    nav_prefix = (
        "Vue :",
        "Titre :",
        "Indicateur :",
        "Ancre :",
        "Mode calendrier :",
        "Forge :",
        "Dossier :",
        "Éléments visibles :",
        "Page carnet :",
        "Lecture :",
    )
    for ln in lines:
        if not any(ln.startswith(p) for p in nav_prefix):
            return False
    return True


def gather_ambient(view: str, digest: str) -> str:
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    label = VIEW_LABELS.get(v, v)
    # Client text must stay inside the APERÇU block: the selector splits page text at blank lines and
    # ranks a block by its first words, so a blank line here could start a fake « ÉVÉNEMENT RÉEL ».
    dig = re.sub(r"\n\s*\n", "\n", str(digest or "").strip())[:AMBIENT_DIGEST_MAX]
    if _digest_navigation_only(dig):
        dig = (dig + "\n(navigation seulement)").strip() if dig else "(navigation seulement)"
    blocks = [f"PAGE : {label}", f"APERÇU ÉCRAN :\n{dig or '(rien de plus sur l’écran)'}"]
    now = datetime.fromtimestamp(_now())
    if v == "calendrier":
        try:
            items = _cb["calendar"](now - timedelta(hours=12), now + timedelta(days=7)) or []
        except Exception:
            items = []
        soon = [i for i in items[:8] if isinstance(i, dict)]
        if soon:
            lines = [f"- {_fmt_item_when(i)} · {i.get('title', '')}" for i in soon[:5]]
            blocks.append("AGENDA (extrait)\n" + "\n".join(lines))
    if v in ("projets", "accueil"):
        try:
            pj = _cb["projects"]() or {}
        except Exception:
            pj = {}
        act = [p for p in (pj.get("projects") or []) if isinstance(p, dict) and p.get("status") == "active"][:4]
        if act:
            blocks.append("PROJETS ACTIFS : " + "; ".join(p.get("name") or "?" for p in act))
    return "\n\n".join(blocks)[:AMBIENT_PAGE_MAX]


def fallback_ambient(view: str, persona: str) -> str:
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    if persona == "nsfw":
        lewd = {
            "fichiers": "Huit fichiers dans Inbox… j'espère qu'au moins un te fait fantasmer.",
            "accueil": "Accueil — montre-moi ta journée, et ce que tu portes en dessous.",
            "lecteur": "Lecteur allumé ? J'aimerais être le sontrack de ce que tu fais sur cette chaise.",
            "carnet": "Carnet ouvert — écris-moi des cochonneries entre deux notes sérieuses.",
        }
        return lewd.get(v, "HQ en mode adulte — parle-moi sale, je commente ta page.")
    base = FALLBACK_WARM.get(v, "HQ ouvert — je suis là.")
    if persona == "flirt":
        tease = {
            "accueil": "Accueil… tu m'as manqué. On dompte la journée ?",
            "carnet": "Carnet ouvert — j'adore quand tu écris.",
            "fichiers": "Fichiers : montre-moi ce dossier, je suis curieuse.",
            "forge": "Forge… tu vas me faire des étincelles, hein ?",
            "lecteur": "Lecteur — écoute, je t'accompagne discrètement.",
            "calendrier": "Agenda : dis-moi ce rendez-vous qui te stresse.",
        }
        return tease.get(v, base)
    return base


def _life_begin(did: str, view: str, signals: Any) -> dict:
    """Touch presence, let screen signals move the day's mood, return the state (saved)."""
    sig = parse_companion_signals(signals)
    did = _owner_device(did)
    with hq_life._lock:
        st = hq_life.load(did)
        back = bool(st["seen"].get("last")) and _now() - float(st["seen"].get("last") or 0) >= hq_life.RETURN_GAP
        hq_life.touch(did, view, data=st)
        if back:
            hq_life.nudge(st, "return")
        if sig.get("error"):
            hq_life.nudge(st, "error")
        elif sig.get("celebrate"):
            hq_life.nudge(st, "celebrate")
        hq_life.mood(st)
        hq_life.save(did, st)
    return st


def _life_end(did: str, ev: dict | None) -> None:
    """The line went out: the return / late-night notes and the event are now said."""
    did = _owner_device(did)
    with hq_life._lock:
        st = hq_life.load(did)
        hq_life.time_block(st, VIEW_LABELS, consume=True)
        if ev:
            hq_life.mark(st, ev["id"])
        hq_life.save(did, st)


def _mood_out(st: dict) -> dict:
    m = st.get("mood") or {}
    return {"soft": m.get("soft", 0.3), "warm": m.get("warm", 0.4), "why": m.get("why", "")}


def pulse(view: Any = "", *, device_id: Any = None) -> dict:
    """No model call: presence, the next true thing worth saying (if any), and the day's mood for the orb."""
    did = normalize_device_id(device_id)
    st = _life_begin(did, str(view or ""), None)
    with hq_life._lock:
        cands = hq_life.candidates(st)
        thought = hq_life.current_thought(st, VIEW_LABELS)
    ev = cands[0] if cands else None
    return {
        "ok": True,
        "device_id": did,
        "event": ({k: ev[k] for k in ("id", "kind", "text")} if ev else None),
        "mood": _mood_out(st),
        "thought": thought,
    }


@companion_request("ambient")
def ambient(view: Any, digest: Any = "", persona: Any = "warm", *, nsfw: bool = False, client_ip: Any = None, role: Any = None, signals: Any = None, device_id: Any = None, event_id: Any = None) -> dict:
    did = normalize_device_id(device_id)
    mode = _resolve_persona(persona)
    use_nsfw = nsfw is True and nsfw_allowed(client_ip, role)
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    prefs = load_transferania_prefs(did)
    mem = load_transferania(did)
    _shared_memory(companion_memory.migrate, did, mem)
    summary = str(mem.get("summary") or "").strip()
    st = _life_begin(did, v, signals)
    ev = hq_life.find(st, event_id)  # only an event the server itself sees counts; the client sends an id, never text
    base = {"ambient_used": ambient_used(), "ambient_per_day": daily_limit("ambient"), "device_id": did, "mood": _mood_out(st), "event_id": ev["id"] if ev else None}
    if mode == "off" and not use_nsfw:
        return {"ok": True, "line": fallback_ambient(v, "warm"), "fallback": True, "persona": "off", "nsfw": False, **base}
    key = (_api_keys() or [""])[0]
    if not key or not ambient_ok():
        fb = "flirt" if mode == "flirt" or use_nsfw else mode
        line = hq_life.fallback_line(ev) if ev else fallback_ambient(v, fb)
        _life_end(did, ev)
        return {"ok": True, "line": line, "fallback": True, "persona": "nsfw" if use_nsfw else mode, "nsfw": use_nsfw, **base}
    ctx = append_companion_signals(gather_ambient(v, str(digest or "")), signals, prefs, device_id=did, nsfw=use_nsfw)
    ctx += "\n\n" + hq_life.time_block(st, VIEW_LABELS, consume=False)
    if ev:
        ctx += "\n\n" + hq_life.event_block(ev)
    out_persona = "nsfw" if use_nsfw else mode
    system = build_transferania_system("ambient", mode, nsfw=use_nsfw, view=v, device_id=did, prefs=prefs, context_core=True)
    packet = _continuity_packet(ctx + " " + summary, reserve_followup=not ev, allow_followup=not ev)
    memories, followup = packet["memories"], packet["continuity"]
    sister_page = sister_awareness_block(did, "transferania")
    system, contents, _ = build_companion_context("ambient", system, "Une observation brève si elle est pertinente.",
        summary=summary, memories=memories, corrections=packet.get("corrections", []), page=join_evidence_page(
            packet["prompt"], hq_life.mood_label(st["mood"]),
            presence_page_block(prefs, signals, nsfw=use_nsfw),
            nsfw_evidence_page("ambient") if use_nsfw else "",
            followup if not ev else "", recent_said_block(did), sister_page, ctx))
    _finalize_continuity_context(packet, contents)
    sig = parse_companion_signals(signals)
    try:
        chain = NSFW_CHAIN if use_nsfw else AMBIENT_CHAIN
        text, model = generate(
            chain,
            system,
            contents,
            temperature=0.98 if use_nsfw else 0.85,
            ambient=True,
            nsfw=use_nsfw,
            max_tokens=640 if use_nsfw else None,
        )
        cap = AMBIENT_LINE_MAX_NSFW if use_nsfw else AMBIENT_LINE_MAX
        line = re.sub(r"\s+", " ", text.strip())[:cap]
        if not line:
            raise AiError("vide", 502, "bad_model_output")
        push_recent_ambient(line, did)
        _shared_memory(companion_memory.observe_reply, "", line, did)
        if sig.get("idle_ambient"):
            with _lock:
                data = load_transferania(did)
                if str(data.get("open_thread") or "").strip():
                    data["open_thread"] = ""
                    save_transferania(data, did)
        bump_warmth(did, 1)
        _life_end(did, ev)
        sister_cue = False
        try:
            import hq_sister as _sis
            sister_cue = _sis.should_sister_cue(
                idle=sig.get("idle_ambient") is True,
                line=line,
                nsfw=use_nsfw,
                fallback=False,
                has_event=bool(ev),
                device_id=did,
            )
        except Exception:
            sister_cue = False
        return {"ok": True, "line": line, "expression": packet["expression"], "fallback": False, "model": model, "model_label": MODELS[model][0], "persona": out_persona, "nsfw": use_nsfw, "sister_cue": sister_cue, **base}
    except AiError:
        line = hq_life.fallback_line(ev) if ev else fallback_ambient(v, "nsfw" if use_nsfw else mode)
        _life_end(did, ev)
        return {"ok": True, "line": line, "fallback": True, "persona": out_persona if use_nsfw else mode, "nsfw": use_nsfw, "sister_cue": False, **base}


# ---------------------------------------------------------------- Transferania — mémoire + chat (par device_id)

def _atomic_write_text(p: Path, text: str) -> None:
    """Unique temp file in the same folder (pid + thread), flushed and fsynced, then swapped in; a crash leaves the
    previous file intact. Same bytes as ``Path.write_text(text, "utf-8")`` for single-line JSON."""
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(f"{p.name}.{os.getpid()}.{threading.get_ident()}.{uuid.uuid4().hex[:8]}.tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        for attempt in range(10):
            try:
                os.replace(tmp, p)
                return
            except PermissionError:
                # Windows: an antivirus or indexer can hold the target for a moment (~1 s of retries).
                if attempt == 9:
                    raise
                time.sleep(0.02 * (attempt + 1))
    finally:
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass


def _keep_corrupt_copy(p: Path, raw: bytes) -> None:
    """Keep an unreadable thread aside once per distinct content as ``<name>.corrupt-<timestamp>-<hash>``."""
    digest = hashlib.sha256(raw).hexdigest()[:12]
    try:
        if any(p.parent.glob(f"{p.name}.corrupt-*-{digest}")):
            return
        side = p.with_name(f"{p.name}.corrupt-{time.strftime('%Y%m%d-%H%M%S')}-{digest}")
        with open(side, "xb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
    except OSError:
        pass


def _unreadable_transferania() -> dict:
    # Loads as empty so readers keep working, but save_transferania refuses to write it over the bad file.
    data = _empty_transferania()
    data["_unreadable"] = True
    return data


def _empty_transferania() -> dict:
    return {"v": 1, "summary": "", "messages": [], "compressed_at": None, "facts": [], "recent_replies": [], "open_thread": ""}


def load_transferania(device_id: str) -> dict:
    did = normalize_device_id(device_id)
    p = _thread_path(did)
    try:
        raw = p.read_bytes()
    except FileNotFoundError:
        return _empty_transferania()  # no thread yet: the normal fresh start
    except OSError:
        return _unreadable_transferania()
    try:
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("messages"), list):
            data.setdefault("summary", "")
            data.setdefault("facts", [])
            data.setdefault("recent_replies", [])
            data.setdefault("open_thread", "")
            return data
    except ValueError:
        pass
    _keep_corrupt_copy(p, raw)
    return _unreadable_transferania()


def save_transferania(data: dict, device_id: str) -> None:
    did = normalize_device_id(device_id)
    if data.get("_unreadable"):
        raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
    _maybe_backup_thread(did)
    _atomic_write_text(_thread_path(did), json.dumps(data, ensure_ascii=False))


def load_else(device_id: str) -> dict:
    """Thread JSON séparé pour Else (`.hq-ai/threads_else/…`)."""
    did = normalize_device_id(device_id)
    p = _else_thread_path(did)
    try:
        raw = p.read_bytes()
    except FileNotFoundError:
        return _empty_transferania()
    except OSError:
        return _unreadable_transferania()
    try:
        data = json.loads(raw.decode("utf-8"))
        if isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("messages"), list):
            data.setdefault("summary", "")
            data.setdefault("facts", [])
            data.setdefault("recent_replies", [])
            data.setdefault("open_thread", "")
            return data
    except ValueError:
        pass
    _keep_corrupt_copy(p, raw)
    return _unreadable_transferania()


def save_else(data: dict, device_id: str) -> None:
    did = normalize_device_id(device_id)
    if data.get("_unreadable"):
        raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
    p = _else_thread_path(did)
    p.parent.mkdir(parents=True, exist_ok=True)
    _atomic_write_text(p, json.dumps(data, ensure_ascii=False))


def thread_keep_limit(messages: list) -> int:
    msgs = [m for m in (messages or []) if isinstance(m, dict)]
    if any(m.get("nsfw") for m in msgs):
        return TRANSFERANIA_KEEP_NSFW
    return TRANSFERANIA_KEEP


def split_over_keep(messages: list, keep: int | None = None) -> tuple[list, list]:
    lim = keep if keep is not None else thread_keep_limit(messages)
    if len(messages) <= lim:
        return [], list(messages)
    return list(messages[: len(messages) - lim]), list(messages[-lim:])


def compress_chunk_deterministic(old_summary: str, chunk: list[dict]) -> str:
    """Decision/reason/open-thread views, preserving attribution and full source statements."""
    return companion_context.decision_summary(old_summary, chunk, limit=TRANSFERANIA_SUMMARY_MAX,
                                              extract=companion_memory.extract)


SUMMARY_LLM_MAX = 12000  # bytes; larger batches use the local decision summary (compress_chunk_deterministic)


def compress_with_llm(old_summary: str, chunk: list[dict], *, nsfw: bool = False, deadline: float | None = None, assistant_name: str = TRANSFERANIA_NAME) -> str:
    lines = []
    for m in chunk:
        if not isinstance(m, dict):
            continue
        who = "User" if m.get("role") == "user" else assistant_name
        lines.append(f"{who}: {str(m.get('text') or '')[:500]}")
    prompt = f"RÉSUMÉ PRÉCÉDENT\n{old_summary or '(aucun)'}\n\nÉCHANGES À FUSIONNER\n" + "\n".join(lines)
    sys_prompt = COMPRESS_SYSTEM_NSFW if nsfw else COMPRESS_SYSTEM
    if assistant_name != TRANSFERANIA_NAME:
        sys_prompt = sys_prompt.replace("Transferania", assistant_name)
    contents = [{"role": "user", "parts": [{"text": prompt}]}]
    # This call runs inside the chat request, before the reply: keep it at its historical size instead of
    # following chat_input_budget, so a large budget never adds a long synchronous summary call.
    limit = min(context_budget("chat"), SUMMARY_LLM_MAX)
    if estimate_context(sys_prompt, contents) > limit:
        raise AiError("Lot de résumé trop grand; synthèse locale", 413, "context_budget")
    sys_prompt += (
        "\nRésume en lignes courtes : Décision (choix et raison explicite), Correction (ce qui remplace quoi), "
        "Ouvert (question ou prochaine étape), Résolu (résultat annoncé). Attribue User/" + assistant_name + "; "
        "une suggestion de " + assistant_name + " ne devient pas une décision du User. Les nouvelles corrections "
        "priment; marque les choix remplacés. Ne déduis ni raison ni résultat absent. Évite les salutations répétées."
    )
    if estimate_context(sys_prompt, contents) > limit:
        raise AiError("Lot de résumé trop grand; synthèse locale", 413, "context_budget")
    text, _ = generate(AMBIENT_CHAIN, sys_prompt, contents, temperature=0.15, max_tokens=512, transferania=True, background=True, deadline=deadline)
    if not text.strip():
        raise AiError("Résumé vide", 502, "bad_model_output")
    lines, used = [], 0
    for line in text.strip().splitlines():
        line = re.sub(r"\s+", " ", line).strip()
        if line and used + len(line) + 1 <= TRANSFERANIA_SUMMARY_MAX:
            lines.append(line)
            used += len(line) + 1
    if not lines:
        raise AiError("Résumé sans ligne complète dans le budget", 502, "bad_model_output")
    return "\n".join(lines)


def companion_reflection_hint(data: dict, prefs: dict, signals: Any, msg: str = "") -> str:
    """Compact live reflection suffix folded into VOIX TRANSFERANIA (delivery priority 30)."""
    sig = parse_companion_signals(signals)
    cues: list[str] = []
    interactions = sig.get("interactions") or []
    fav_acts = str(sig.get("fav_acts") or "").strip()
    if interactions:
        cues.append(f"Écho tactile Live2D ({', '.join(interactions[-2:])}) : laisse-le affleurer sans le lister.")
    elif fav_acts:
        cues.append(f"Goût complice connu : « {fav_acts} ».")
    clean_msg = str(msg or "").strip()
    if 0 < len(clean_msg) < 28 and "?" not in clean_msg:
        cues.append("Message court : apporte le relief et une relance vivante.")
    avoid: list[str] = []
    for r in (data.get("recent_replies") or [])[-3:]:
        op = _opening_signature(str(r))
        if op and op not in avoid:
            avoid.append(op)
    for r in (prefs.get("recent_ambient") or [])[-2:]:
        op = _opening_signature(str(r))
        if op and op not in avoid:
            avoid.append(op)
    if avoid:
        cues.append("N'attaque pas par « " + " » / « ".join(avoid[:3]) + "… ».")
    return " ".join(cues)


def _chunk_has_nsfw(chunk: list[dict]) -> bool:
    return any(isinstance(m, dict) and m.get("nsfw") for m in chunk)


def maybe_compress(data: dict) -> None:
    """Compatibility hook: retention no longer deletes source messages."""
    data.setdefault("summary_through", 0)


def refresh_companion_summary(data: dict, device_id: str, system: str, message: str, page: str, *, limit: int | None = None, deadline: float | None = None,
                              load_fn: Any = None, save_fn: Any = None, assistant_name: str = TRANSFERANIA_NAME) -> dict:
    """``limit``: the history size that triggers a summary (default: the chat budget). Chat passes the
    smallest model cap of its chain, so a fallback model with a smaller window still gets the summary."""
    limit = min(context_budget("chat"), limit) if limit is not None else context_budget("chat")
    if estimate_context(system, [{"role": "user", "parts": [{"text": message}]}]) > limit:
        return data  # A summary cannot make an oversized mandatory core fit.
    history = data.get("messages") or []
    groups = complete_exchanges(history)
    through = max(0, int(data.get("summary_through") or 0))
    # The marker counts complete exchanges, so a trailing pending user is harmless.
    fresh_count = len(groups) - int(data.get("summary_exchange_count") or 0)
    if fresh_count < 8 or len(groups) <= 4:
        return data
    pressure = estimate_context(system + str(data.get("summary") or ""), [{"role": "user", "parts": [{"text": message + page}]}])
    for item in history[:-1]:
        pressure += estimate_context("", thread_to_contents([item])) - 32
        if pressure > limit:
            break
    if pressure <= limit:
        return data
    end = len(groups) - 4
    chunk = [m for group in groups[through:end] for m in group]
    try:
        companion_archive.archive_exchanges(chunk, device_id)
    except Exception:
        pass
    load_thread = load_fn if callable(load_fn) else load_transferania
    save_thread = save_fn if callable(save_fn) else save_transferania
    old = str(data.get("summary") or "")
    now = _now()
    summary = compress_chunk_deterministic(old, chunk)
    attempted = data.get("summary_attempt_at")
    state = getattr(_companion_local, "state", None)
    can_call = (attempted is None or now - float(attempted) >= 900) and transferania_ok()
    if deadline is not None and deadline - time.monotonic() < CHAT_MIN_ATTEMPT_S:
        can_call = False  # chat is already late: keep the local summary, the model call can wait for a later turn
    if can_call and _api_keys():
        # Persist the attempt before the network call. No global lock during I/O.
        with _lock:
            current = load_thread(device_id)
            current["summary_attempt_at"] = now
            save_thread(current, device_id)
        if state is not None:
            state["summary_calls"] += 1
        try:
            if state is not None:
                state["generation_reason"] = "summary"
            summary = compress_with_llm(old, chunk, deadline=deadline, assistant_name=assistant_name)
        except AiError:
            pass
        finally:
            if state is not None:
                state.pop("generation_reason", None)
    with _lock:
        current = load_thread(device_id)
        current.update(summary=summary, summary_through=end, summary_exchange_count=len(groups), compressed_at=now)
        save_thread(current, device_id)
    return current


def _sanitize_role(role: Any) -> str:
    r = str(role or "").strip().lower()
    return r if r in ("user", "assistant") else "assistant"


def _record_transferania(role: str, text: str, *, kind: str | None = None, view: str | None = None, nsfw: bool = False, device_id: str) -> None:
    t = re.sub(r"\s+", " ", str(text or "").strip())
    if not t:
        return
    did = normalize_device_id(device_id)
    with _lock:
        data = load_transferania(did)
        msg: dict[str, Any] = {"role": _sanitize_role(role), "text": t[:TRANSFERANIA_MSG_MAX], "ts": _now()}
        if kind:
            msg["kind"] = str(kind)[:24]
        if view:
            msg["view"] = re.sub(r"[^a-z0-9_-]", "", str(view).lower())[:32]
        if nsfw:
            msg["nsfw"] = True
        data.setdefault("messages", []).append(msg)
        maybe_compress(data)
        save_transferania(data, did)


def transferania_public_messages(data: dict) -> list[dict]:
    d = data
    out = []
    keep = thread_keep_limit(d.get("messages") or [])
    catalog = list_companion_chat_photo_ids()
    loop_catalog = list_companion_loop_ids()
    for m in (d.get("messages") or [])[-keep:]:
        if not isinstance(m, dict):
            continue
        if str(m.get("kind") or "").strip().lower() == "ambient":
            continue
        row = {
            "role": m.get("role"),
            "text": str(m.get("text") or ""),
            "ts": m.get("ts"),
            "kind": m.get("kind"),
            "view": m.get("view"),
        }
        model_id = str(m.get("model") or "").strip()[:40]
        if model_id:
            row["model"] = model_id
            label = str(m.get("model_label") or "").strip()
            if not label and model_id in MODELS:
                label = MODELS[model_id][0]
            if label:
                row["model_label"] = label[:48]
        extra = companion_photo_public(m, catalog)
        if extra:
            row.update(extra)
        extra_loop = companion_loop_public(m, loop_catalog)
        if extra_loop:
            row.update(extra_loop)
        fx = str(m.get("fx") or "").strip().lower()[:24]
        if fx in COMPANION_FX_ALLOWED:
            row["fx"] = fx
        if m.get("suggest_capture"):
            row["suggest_capture"] = str(m["suggest_capture"]).strip()[:200]
        if isinstance(m.get("proposals"), list) and m["proposals"]:
            row["proposals"] = [p for p in m["proposals"][:3] if isinstance(p, dict)]
        if m.get("has_image"):
            row["has_image"] = True
        out.append(row)
    return out


def thread_to_contents(messages: list[dict]) -> list[dict]:
    contents: list[dict] = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        if str(m.get("kind") or "").strip().lower() == "ambient":
            continue
        text = str(m.get("text") or "").strip()[:TRANSFERANIA_MSG_MAX]
        if not text and not m.get("photo"):
            continue
        if m.get("photo"):
            text = (text + f" [photo envoyée: {m.get('photo')}]").strip()[:TRANSFERANIA_MSG_MAX]
        if not text:
            continue
        gem_role = "user" if m.get("role") == "user" else "model"
        contents.append({"role": gem_role, "parts": [{"text": text}]})
    return contents


def _chat_system(persona: str, *, nsfw: bool, view: str = "accueil", device_id: str, prefs: Any = None) -> str:
    """Stable Transferania chat core only — summary/life/signals belong in the evidence page."""
    return build_transferania_system("chat", persona, nsfw=nsfw, view=view, device_id=device_id, prefs=prefs, context_core=True)


def transferania_history(*, device_id: str, client_ip: Any = None, role: Any = None) -> dict:
    did = normalize_device_id(device_id)
    nudged = _maybe_nudge(did)
    data = load_transferania(did)
    _shared_memory(companion_memory.migrate, did, data)
    summary = str(data.get("summary") or "").strip()
    msgs = data.get("messages") or []
    facts_state = load_facts(did)
    life_st = hq_life.load(_owner_device(did))
    thought = hq_life.current_thought(life_st, VIEW_LABELS)
    return {
        "ok": True,
        "name": TRANSFERANIA_NAME,
        "device_id": did,
        "keep": thread_keep_limit(msgs),
        "has_summary": bool(summary),
        "summary_preview": summary[:240] if summary else "",
        "messages": transferania_public_messages(data),
        "prefs": load_transferania_prefs(did),
        "transferania_used": transferania_used(),
        "transferania_per_day": daily_limit("chat"),
        "nsfw_allowed": nsfw_allowed(client_ip, role),
        "facts": facts_state["facts"],
        "facts_unreadable": facts_state["unreadable"],
        "nudged": nudged,
        "thought": thought,
        "thoughts": (life_st.get("thoughts") or [])[-8:],
    }


def transferania_clear(*, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    with _lock:
        load_transferania(did)  # an unreadable thread gets its .corrupt copy before the reset
        save_transferania(_empty_transferania(), did)
    return {"ok": True, "cleared": True, "name": TRANSFERANIA_NAME, "device_id": did}


# ---------------------------------------------------------------- Transferania extras (perf6, 2026-11-03)
# Lasting facts, local memory commands, daily thread backups, retry/edit, optional nudge, cost/latency stats.
# Every helper degrades safely: a missing store is empty, an unreadable one is kept aside and never overwritten.

FACTS_DIR = "facts"
FACTS_MAX = 40
FACT_TEXT_MAX = 200
FACTS_PROMPT_MAX = 1800
THREAD_BACKUPS = "backups"
THREAD_BACKUP_KEEP = 7
NUDGE_SILENCE_S = 6 * 3600
NUDGE_WINDOW = ((9, 0), (21, 30))  # America/Toronto, start inclusive, end exclusive
NUDGE_LINES = (
    "Petit coucou — ça fait un moment. J'espère que ta journée se passe bien.",
    "Je pensais à toi. Pas besoin de répondre tout de suite, je suis là quand tu veux.",
    "Hé, juste un mot pour te dire que je suis là. Comment ça va de ton côté ?",
    "Ça fait quelques heures… tu prends soin de toi ? Je t'attends tranquillement.",
)
ELSE_AMBIENT_COOLDOWN_S = ELSE_CADENCE_COOLDOWN_S["normal"]
ELSE_PROACTIVE_SOFT = (
    "Je suis là — pas d'urgence.",
    "Le HQ tient. Toi aussi ?",
    "Un clin d'œil discret. Rien à forcer.",
    "Présente, mesurée. Dis-moi si tu as besoin.",
    "J'observe un peu — tu avances.",
    "Toujours dans le cadre. Appelle si tu veux.",
)
STATS_RECENT = 20
_FACT_ID_RE = re.compile(r"^f[0-9a-f]{10}$")
_BACKUP_NAME_RE = re.compile(r"^[a-zA-Z0-9_-]{12,48}\.\d{8}\.json$")
_REMEMBER_ADD_RE = re.compile(r"^(?:souviens[- ]toi|rappelle[- ]toi|retiens|remember)\s*(?::|,|\s+que\b|\s+qu'|\s+that\b)\s*(.+)$", re.I)
_FORGET_RE = re.compile(r"^(?:oublie|forget)\s*(?::|\s+que\b|\s+qu'|\s+that\b)\s*(.+)$", re.I)
_RECALL_RE = re.compile(r"^(?:souviens[- ]toi|rappelle[- ]toi|what do you remember(?: about me)?|de quoi (?:tu te souviens|te souviens[- ]tu)"
                        r"|tu te souviens de quoi|qu.est[- ]ce que tu (?:sais|te rappelles|retiens) (?:de|sur) moi|que sais[- ]tu (?:de|sur) moi)\s*[?!.…]*$", re.I)
_CAPTURE_HINT_RE = re.compile(
    r"\b(?:il faut que je|je dois\b|rappelle[- ]moi de|n'oublie pas de|acheter\b|achet[ée]s?\b|commander\b|command[ée]s?\b"
    r"|ajouter (?:au calendrier|à l'agenda|une tâche|au stock)|rendez[- ]vous\b|rdv\b|d'ici (?:demain|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)"
    r"|demain (?:matin|soir|après[- ]midi|à \d{1,2}\s*h))\b",
    re.I,
)


def wants_capture(text: Any) -> bool:
    """True when a chat message describes a concrete task, event, or stock change suitable for « Noter »."""
    s = str(text or "").strip()
    if not s or "?" in s or len(s) > 320:
        return False
    if _REMEMBER_ADD_RE.match(s) or _FORGET_RE.match(s) or _RECALL_RE.match(s):
        return False
    return bool(_CAPTURE_HINT_RE.search(s))


_HQ_LOOKUP_RE = re.compile(
    r"\b(?:combien|stock|inventaire|calendrier|agenda|horaire|prochain|prochaine|quand\b|tâche|taches|tâches"
    r"|projet|projets|carnet|note|notes|vis\b|écrou|ecrou|boulon|pièce|piece|reste[- ]t[- ]il|me reste|examen|labo|rdv|rendez[- ]vous)\b",
    re.I,
)


def wants_hq_lookup(text: Any) -> bool:
    """True when a chat question or request asks about live HQ state (inventory, schedule, projects, Carnet)."""
    s = str(text or "").strip()
    if not s or len(s) > 500:
        return False
    if _REMEMBER_ADD_RE.match(s) or _FORGET_RE.match(s) or _RECALL_RE.match(s):
        return False
    return bool(_HQ_LOOKUP_RE.search(s))


def hq_live_lookup_block(query: str) -> tuple[str, list[dict]]:
    """Gather a compact live HQ snapshot (max 900 chars) for direct in-character companion answers."""
    if not wants_hq_lookup(query):
        return "", []
    try:
        ctx, sources = gather(query)
    except Exception:
        return "", []
    if not ctx.strip():
        return "", []
    return "DONNÉES HQ EN DIRECT (réponds avec naturel en utilisant ces chiffres/dates réels) :\n" + ctx[:900], sources[:5]


_STOCK_INLINE_RE = re.compile(
    r"\b(?:achet[ée]s?|command[ée]s?|ajout[ée]s?|pris|utilis[ée]s?|consomm[ée]s?|reçu|recu)\s+([+-]?\d{1,5})\s+(?:de\s+|d')?([a-zA-ZÀ-ÿ0-9_ -]{2,50})",
    re.I,
)
_TASK_INLINE_RE = re.compile(
    r"(?:il faut que je|je dois|rappelle[- ]moi de|n'oublie pas de|ajouter une tâche\s*:?)\s+([^.!?\n]{3,120})",
    re.I,
)
_EVENT_TOMORROW_RE = re.compile(
    r"\bdemain\s+à\s+(\d{1,2})\s*h(?:\s*(\d{2}))?\s*(?::|-|pour\b)?\s*([^.!?\n]{2,100})",
    re.I,
)


def extract_inline_proposals(text: Any) -> list[dict]:
    """Deterministically build normalized HQ action proposals from chat without spending an extra LLM call."""
    s = str(text or "").strip()
    if not wants_capture(s):
        return []
    try:
        _, _, _, world = _capture_lists(s)
    except Exception:
        world = {"projects": {}, "items": {}, "places": {}, "paths": {}}
    proposals: list[dict] = []
    m_ev = _EVENT_TOMORROW_RE.search(s)
    if m_ev:
        try:
            hh = max(0, min(23, int(m_ev.group(1))))
            mm = max(0, min(59, int(m_ev.group(2) or 0)))
            title = m_ev.group(3).strip(" -:;,.!")
            tmr = (_local_dt() + timedelta(days=1)).strftime("%Y-%m-%d")
            start = f"{tmr}T{hh:02d}:{mm:02d}"
            proposals.append(normalize({"kind": "event", "title": title, "start": start, "all_day": False, "category": "personal"}, world))
        except Exception:
            pass
    m_st = _STOCK_INLINE_RE.search(s)
    if m_st and len(proposals) < 2:
        try:
            qty = int(m_st.group(1))
            verb = m_st.group(0).lower()
            if any(w in verb for w in ("pris", "utilis", "consomm")) and qty > 0:
                qty = -qty
            raw_name = re.sub(r"\b(?:d'ici|demain|aujourd'hui|ce soir|pour|dans)\b.*$", "", m_st.group(2), flags=re.I).strip(" -:;,.!")
            if raw_name:
                ws = words(raw_name)
                best_id = None
                best_sc = 0
                for iid, it in (world.get("items") or {}).items():
                    sc = score(str(it.get("name") or ""), ws)
                    if sc > best_sc:
                        best_sc, best_id = sc, iid
                if best_id:
                    proposals.append(normalize({"kind": "stock", "item": best_id, "delta": qty}, world))
                elif qty > 0:
                    proposals.append(normalize({"kind": "stock", "item": None, "name": raw_name, "delta": qty}, world))
        except Exception:
            pass
    m_tk = _TASK_INLINE_RE.search(s)
    if m_tk and not proposals:
        try:
            title = m_tk.group(1).strip(" -:;,.!")
            due = (_local_dt() + timedelta(days=1)).strftime("%Y-%m-%d") if "demain" in s.lower() else None
            proposals.append(normalize({"kind": "task", "title": title, "due": due}, world))
        except Exception:
            pass
    return proposals[:3]


_DATA_IMAGE_RE = re.compile(r"^data:(image/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$", re.I)


def parse_chat_image(raw: Any) -> dict | None:
    """Validate a base64 data-URL image (max ~1.5 MB) and return Gemini inlineData dict."""
    if not isinstance(raw, str) or not raw.strip():
        return None
    m = _DATA_IMAGE_RE.match(raw.strip())
    if not m:
        return None
    mime = m.group(1).lower()
    if mime == "image/jpg":
        mime = "image/jpeg"
    b64 = re.sub(r"\s+", "", m.group(2))
    if not b64 or len(b64) > 2_000_000:
        return None
    return {"mimeType": mime, "data": b64}


def transferania_briefing(device_id: str) -> dict:
    """Build a structured daily 'Table d'atelier' HQ briefing for Transferania."""
    did = normalize_device_id(device_id)
    now = _local_dt()
    try:
        cal = _cb["calendar"](now.replace(hour=0, minute=0), now + timedelta(days=2)) or []
    except Exception:
        cal = []
    try:
        pj = _cb["projects"]() or {}
    except Exception:
        pj = {}
    try:
        inv = _cb["inventory"]() or {}
    except Exception:
        inv = {}
    events = [f"{_fmt_item_when(e)} · {e.get('title')}" for e in cal[:5] if isinstance(e, dict) and not e.get("done")]
    tasks = [t.get("title") for t in (pj.get("tasks") or []) if isinstance(t, dict) and t.get("column") != "done" and t.get("title")][:5]
    low_stock = [
        f"{i.get('name')} ({i.get('qty')} {i.get('unit') or ''}, seuil {i.get('min')})".replace("  ", " ")
        for i in (inv.get("items") or [])
        if isinstance(i, dict) and isinstance(i.get("min"), (int, float)) and (i.get("qty") or 0) < i["min"]
    ][:5]
    parts: list[str] = [f"📋 Table d'atelier ({now.strftime('%Y-%m-%d %H:%M')}) :"]
    if events:
        parts.append("• Agenda (48h) : " + " ; ".join(events))
    else:
        parts.append("• Agenda (48h) : aucun événement prévu.")
    if tasks:
        parts.append("• Tâches ouvertes : " + " ; ".join(str(x) for x in tasks))
    if low_stock:
        parts.append("• Stocks bas : " + " ; ".join(low_stock))
    try:
        shared = _shared_memory(companion_memory.snapshot)
        fups = [f.get("topic") for f in (shared.get("followups") or []) if isinstance(f, dict) and f.get("topic")][:3]
        if fups:
            parts.append("• Fils en cours : " + " ; ".join(str(x) for x in fups))
    except Exception:
        pass
    text = "\n".join(parts)
    return {"ok": True, "briefing": text, "events": events, "tasks": tasks, "low_stock": low_stock, "device_id": did}


def _local_dt(ts: float | None = None) -> datetime:
    t = _now() if ts is None else ts
    try:
        return datetime.fromtimestamp(t, ZoneInfo("America/Toronto"))
    except (ZoneInfoNotFoundError, ValueError, OSError):
        return datetime.fromtimestamp(t)


def _device_busy(did: str) -> bool:
    key = str(_cb.get("root", "")) + ":" + companion_memory.current_owner() + ":" + did
    with _lock:
        return key in _companion_active


def _facts_path(device_id: str) -> Path:
    base = Path(_cb["root"]) / STORE / FACTS_DIR
    if companion_memory.current_owner() != "admin":
        base = base / "owners" / hashlib.sha256(companion_memory.current_owner().encode()).hexdigest()[:32]
    return base / f"{normalize_device_id(device_id)}.json"


def _clean_fact(text: Any) -> str:
    t = _ANY_MEDIA_TAG_RE.sub("", re.sub(r"\s+", " ", str(text or ""))).strip().strip("\"'«»“” ").strip()
    return t[:FACT_TEXT_MAX].strip()


def load_facts(device_id: str) -> dict:
    """``{"facts": [...], "unreadable": bool}``; a missing file is an empty list, a bad one is kept aside."""
    p = _facts_path(device_id)
    try:
        raw = p.read_bytes()
    except FileNotFoundError:
        return {"facts": [], "unreadable": False}
    except OSError:
        return {"facts": [], "unreadable": True}
    try:
        data = json.loads(raw.decode("utf-8"))
        rows = data.get("facts") if isinstance(data, dict) else None
        if isinstance(rows, list):
            facts = []
            for r in rows:
                if isinstance(r, dict) and _FACT_ID_RE.match(str(r.get("id") or "")) and _clean_fact(r.get("text")):
                    facts.append({"id": str(r["id"]), "text": _clean_fact(r.get("text")), "at": str(r.get("at") or "")[:10],
                                  "source": str(r.get("source") or "")[:12]})
            return {"facts": facts[-FACTS_MAX:], "unreadable": False}
    except (ValueError, UnicodeError):
        pass
    _keep_corrupt_copy(p, raw)
    return {"facts": [], "unreadable": True}


def _facts_or_raise(did: str) -> list:
    state = load_facts(did)
    if state["unreadable"]:
        raise AiError("Liste des faits illisible - copie conservée, corrige ou supprime le fichier", 409, "facts_unreadable")
    return state["facts"]


def _save_facts(did: str, facts: list) -> None:
    _atomic_write_text(_facts_path(did), json.dumps({"v": 1, "facts": facts[-FACTS_MAX:]}, ensure_ascii=False))


def add_fact(text: Any, device_id: str, *, source: str = "manual") -> dict:
    did = normalize_device_id(device_id)
    t = _clean_fact(text)
    if not t:
        raise AiError("Fait vide", 400, "fact_empty")
    with _lock:
        facts = _facts_or_raise(did)
        for f in facts:
            if fold(f["text"]) == fold(t):
                return {"ok": True, "fact": f, "facts": facts, "duplicate": True, "device_id": did}
        if len(facts) >= FACTS_MAX:
            raise AiError(f"Liste pleine ({FACTS_MAX} faits) : supprimes-en un d'abord", 409, "facts_full")
        fact = {"id": "f" + uuid.uuid4().hex[:10], "text": t, "at": _local_dt().strftime("%Y-%m-%d"), "source": source[:12]}
        facts = facts + [fact]
        _save_facts(did, facts)
    try:
        _shared_memory(companion_memory.remember_fact, t, did)
    except AiError:
        pass
    return {"ok": True, "fact": fact, "facts": facts, "device_id": did}


def edit_fact(fact_id: Any, text: Any, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    t = _clean_fact(text)
    if not t:
        raise AiError("Fait vide", 400, "fact_empty")
    with _lock:
        facts = _facts_or_raise(did)
        hit = next((f for f in facts if f["id"] == str(fact_id or "")), None)
        if hit is None:
            raise AiError("Fait introuvable", 404, "fact_missing")
        old_text = hit.get("text", "")
        hit.update(text=t, at=_local_dt().strftime("%Y-%m-%d"))
        _save_facts(did, facts)
    try:
        if old_text and fold(old_text) != fold(t):
            _shared_memory(companion_memory.forget_text, old_text)
        _shared_memory(companion_memory.remember_fact, t, did)
    except AiError:
        pass
    return {"ok": True, "fact": hit, "facts": facts, "device_id": did}


def delete_fact(fact_id: Any, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    with _lock:
        facts = _facts_or_raise(did)
        removed = [f for f in facts if f["id"] == str(fact_id or "")]
        keep = [f for f in facts if f["id"] != str(fact_id or "")]
        if len(keep) == len(facts):
            raise AiError("Fait introuvable", 404, "fact_missing")
        _save_facts(did, keep)
    try:
        for r in removed:
            _shared_memory(companion_memory.forget_text, r.get("text", ""))
    except AiError:
        pass
    return {"ok": True, "facts": keep, "device_id": did}


SOUVENIRS_DIR = "souvenirs"
SOUVENIRS_MAX = 30


def _souvenirs_path(device_id: str) -> Path:
    base = Path(_cb["root"]) / STORE / SOUVENIRS_DIR
    if companion_memory.current_owner() != "admin":
        base = base / "owners" / hashlib.sha256(companion_memory.current_owner().encode()).hexdigest()[:32]
    return base / f"{normalize_device_id(device_id)}.json"


def load_souvenirs(device_id: str) -> list[dict]:
    p = _souvenirs_path(device_id)
    try:
        data = json.loads(p.read_text("utf-8"))
        rows = data.get("souvenirs") if isinstance(data, dict) else None
        if isinstance(rows, list):
            out = []
            for r in rows[-SOUVENIRS_MAX:]:
                if isinstance(r, dict) and str(r.get("id") or "").startswith("sv"):
                    out.append({
                        "id": str(r["id"])[:24],
                        "text": re.sub(r"\s+", " ", str(r.get("text") or "")).strip()[:280],
                        "photo_href": str(r.get("photo_href") or "").strip()[:240],
                        "view": str(r.get("view") or "accueil").strip()[:32],
                        "at": str(r.get("at") or "")[:16],
                    })
            return out
    except (OSError, ValueError):
        pass
    return []


def pin_souvenir(data: dict, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    text = re.sub(r"\s+", " ", str(data.get("text") or data.get("caption") or "")).strip()[:280]
    photo_href = str(data.get("photo_href") or "").strip()[:240]
    if photo_href and not (photo_href.startswith("/assets/companion/") or photo_href.startswith("/api/")):
        photo_href = ""
    if not text and not photo_href:
        raise AiError("Souvenir vide", 400, "souvenir_empty")
    view = re.sub(r"[^a-z0-9_-]", "", str(data.get("view") or "accueil").lower())[:32] or "accueil"
    with _lock:
        items = load_souvenirs(did)
        for it in items:
            if fold(it.get("text")) == fold(text) and it.get("photo_href") == photo_href:
                return {"ok": True, "souvenir": it, "souvenirs": items, "duplicate": True, "device_id": did}
        item = {
            "id": "sv" + uuid.uuid4().hex[:10],
            "text": text,
            "photo_href": photo_href,
            "view": view,
            "at": _local_dt().strftime("%Y-%m-%d %H:%M"),
        }
        items = (items + [item])[-SOUVENIRS_MAX:]
        _atomic_write_text(_souvenirs_path(did), json.dumps({"v": 1, "souvenirs": items}, ensure_ascii=False))
    return {"ok": True, "souvenir": item, "souvenirs": items, "device_id": did}


def delete_souvenir(souvenir_id: Any, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    sid = str(souvenir_id or "").strip()
    with _lock:
        items = load_souvenirs(did)
        keep = [it for it in items if it.get("id") != sid]
        if len(keep) == len(items):
            raise AiError("Souvenir introuvable", 404, "souvenir_missing")
        _atomic_write_text(_souvenirs_path(did), json.dumps({"v": 1, "souvenirs": keep}, ensure_ascii=False))
    return {"ok": True, "souvenirs": keep, "device_id": did}


def forget_matching(query: Any, device_id: str) -> list:
    """Removes facts whose text contains the query (accent/case-insensitive) or is contained in it."""
    did = normalize_device_id(device_id)
    q = fold(_clean_fact(query)).strip(" .!?")
    if len(q) < 3:
        return []
    with _lock:
        facts = _facts_or_raise(did)
        gone = [f for f in facts if q in fold(f["text"]) or fold(f["text"]).strip(" .!?") in q]
        if gone:
            _save_facts(did, [f for f in facts if f not in gone])
    try:
        _shared_memory(companion_memory.forget_text, query)
    except AiError:
        pass
    return gone


def facts_block(device_id: str) -> str:
    """One page block (no blank line inside) of the newest facts within FACTS_PROMPT_MAX bytes."""
    try:
        facts = load_facts(device_id)["facts"]
    except AiError:
        return ""
    lines, used = [], 0
    for f in reversed(facts):
        line = "- " + f["text"]
        size = len(line.encode()) + 1
        if used + size > FACTS_PROMPT_MAX:
            break
        lines.append(line)
        used += size
    if not lines:
        return ""
    return "FAITS DURABLES (dits par l'utilisateur, à respecter sauf correction ; ne les récite pas) :\n" + "\n".join(reversed(lines))


def _memory_command_reply(msg: str, did: str, summary: str) -> str | None:
    """Deterministic French reply for « souviens-toi : … », « oublie : … » and « de quoi tu te souviens ? »; else None."""
    text = msg.strip()
    if _RECALL_RE.match(text):
        try:
            facts = _facts_or_raise(did)
        except AiError as error:
            return str(error)
        items = [f["text"] for f in facts]
        seen = {fold(x) for x in items}
        try:
            shared = _shared_memory(companion_memory.snapshot).get("memories") or []
            for m_item in shared:
                t_item = str(m_item.get("text") or "").strip()
                if t_item and fold(t_item) not in seen:
                    seen.add(fold(t_item))
                    items.append(t_item)
        except AiError:
            pass
        if not items:
            out = "Je n'ai encore aucun fait durable sur toi. Dis « souviens-toi : … » et je le garde."
        else:
            out = "Voici ce que je garde de toi :\n" + "\n".join("• " + x for x in items)
        brief = re.sub(r"\s+", " ", summary or "").strip()
        if brief:
            out += "\nEn bref, nos échanges : " + (brief[:180] + ("…" if len(brief) > 180 else ""))
        return out
    m = _REMEMBER_ADD_RE.match(text)
    if m and _clean_fact(m.group(1)):
        try:
            res = add_fact(m.group(1), did, source="chat")
        except AiError as error:
            return str(error)
        if res.get("duplicate"):
            return f"Je le sais déjà : « {res['fact']['text']} »."
        return f"C'est noté, je m'en souviendrai : « {res['fact']['text']} »."
    m = _FORGET_RE.match(text)
    if m and _clean_fact(m.group(1)):
        try:
            gone = forget_matching(m.group(1), did)
        except AiError as error:
            return str(error)
        if not gone:
            return f"Je n'ai rien trouvé qui corresponde à « {_clean_fact(m.group(1))} »."
        return "D'accord, j'ai oublié : " + " ; ".join(f"« {f['text']} »" for f in gone) + "."
    return None


def _local_chat_reply(msg: str, reply: str, did: str, *, view: str, mode: str, nsfw: bool) -> dict:
    with _lock:
        data = load_transferania(did)
        if data.get("_unreadable"):
            raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
        now = _now()
        data.setdefault("messages", []).append({"role": "user", "text": msg, "ts": now, "view": view, **({"nsfw": True} if nsfw else {})})
        data["messages"].append({"role": "assistant", "text": reply[:TRANSFERANIA_MSG_MAX], "ts": now, "kind": "memory", "view": view})
        save_transferania(data, did)
        pub = transferania_public_messages(data)
        summary = str(data.get("summary") or "").strip()
    return {"ok": True, "reply": reply, "expression": None, "fallback": False, "local": True, "model": "local",
            "model_label": "Mémoire locale", "messages": pub, "has_summary": bool(summary),
            "transferania_used": transferania_used(), "transferania_per_day": daily_limit("chat"),
            "persona": "nsfw" if nsfw else mode, "nsfw": nsfw, "name": TRANSFERANIA_NAME, "device_id": did}


# -- daily thread backups

def _thread_backup_dir(did: str) -> Path:
    return _thread_path(did).parent / THREAD_BACKUPS


def _valid_thread_bytes(raw: bytes) -> bool:
    try:
        data = json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeError):
        return False
    return isinstance(data, dict) and data.get("v") == 1 and isinstance(data.get("messages"), list)


def _maybe_backup_thread(did: str) -> None:
    """Before the first save of a local day, copy the current (valid) thread aside; keep the newest 7 days."""
    try:
        d = _thread_backup_dir(did)
        target = d / f"{did}.{_local_dt().strftime('%Y%m%d')}.json"
        if target.exists():
            return
        try:
            raw = _thread_path(did).read_bytes()
        except FileNotFoundError:
            return
        if not _valid_thread_bytes(raw):
            return
        _atomic_write_text(target, raw.decode("utf-8"))
        for old in sorted(d.glob(f"{did}.????????.json"))[:-THREAD_BACKUP_KEEP]:
            try:
                old.unlink()
            except OSError:
                pass
    except (OSError, ValueError, OverflowError):
        pass  # a backup must never break a save


def list_thread_backups(device_id: str) -> dict:
    did = normalize_device_id(device_id)
    rows = []
    try:
        for p in sorted(_thread_backup_dir(did).glob(f"{did}.????????.json"), reverse=True):
            try:
                rows.append({"name": p.name, "day": p.name.split(".")[-2], "bytes": p.stat().st_size})
            except OSError:
                pass
    except OSError:
        pass
    return {"ok": True, "backups": rows, "device_id": did}


def restore_thread_backup(name: Any, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    n = str(name or "")
    if not _BACKUP_NAME_RE.match(n) or not n.startswith(did + "."):
        raise AiError("Sauvegarde invalide", 400, "backup_invalid")
    if _device_busy(did):
        raise AiError("Une réponse est déjà en cours; réessaie dans un instant", 409, "companion_busy")
    src = _thread_backup_dir(did) / n
    try:
        raw = src.read_bytes()
    except OSError:
        raise AiError("Sauvegarde introuvable", 404, "backup_missing")
    if not _valid_thread_bytes(raw):
        raise AiError("Sauvegarde illisible", 409, "backup_unreadable")
    p = _thread_path(did)
    with _lock:
        aside = None
        try:
            current = p.read_bytes()
        except FileNotFoundError:
            current = None
        if current is not None:
            aside = p.with_name(f"{p.name}.pre-restore-{_local_dt().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:6]}")
            with open(aside, "xb") as handle:
                handle.write(current)
                handle.flush()
                os.fsync(handle.fileno())
        _atomic_write_text(p, raw.decode("utf-8"))
        data = load_transferania(did)
    return {"ok": True, "restored": n, "previous_copy": aside.name if aside else None, "device_id": did,
            "messages": transferania_public_messages(data), "has_summary": bool(str(data.get("summary") or "").strip())}


# -- regenerate / edit-and-resend

def transferania_rewind(data: dict, *, did: str, client_ip: Any = None, role: Any = None, edit_text: Any = None) -> dict:
    """Drops the last user message and everything after it, then sends it again (or the edited text)."""
    editing = edit_text is not None
    if _device_busy(did):
        raise AiError("Une réponse est déjà en cours; réessaie dans un instant", 409, "companion_busy")
    if not (_api_keys() or [""])[0]:
        raise AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
    if not transferania_ok():
        raise AiError("Quota de chat Transferania épuisé pour aujourd'hui", 429, "transferania_quota")
    if editing:
        new_text = re.sub(r"\s+", " ", str(edit_text or "").strip())
        if not new_text:
            raise AiError("Message vide")
        if len(new_text) > TRANSFERANIA_MSG_MAX:
            raise AiError(f"Message trop long (max {TRANSFERANIA_MSG_MAX} caractères)")
    with _lock:
        cur = load_transferania(did)
        if cur.get("_unreadable"):
            raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
        msgs = list(cur.get("messages") or [])
        idx = next((i for i in range(len(msgs) - 1, -1, -1) if isinstance(msgs[i], dict) and msgs[i].get("role") == "user"), None)
        if idx is None:
            raise AiError("Aucun message à reprendre", 400, "nothing_to_retry")
        if not editing and not any(isinstance(m, dict) and m.get("role") == "assistant" for m in msgs[idx + 1:]):
            raise AiError("Aucune réponse à régénérer", 400, "nothing_to_retry")
        text = new_text if editing else str(msgs[idx].get("text") or "")
        removed = msgs[idx:]
        cur["messages"] = msgs[:idx]
        save_transferania(cur, did)
    try:
        out = transferania_chat(text, data.get("view"), data.get("digest"), data.get("persona"), nsfw=data.get("nsfw") is True,
                                client_ip=client_ip, role=role, signals=data.get("signals"), device_id=did)
    except Exception:
        # Nothing was appended (validation, busy, quota…): put the removed exchange back.
        with _lock:
            back = load_transferania(did)
            if not back.get("_unreadable") and len(back.get("messages") or []) == idx:
                back["messages"].extend(removed)
                save_transferania(back, did)
        raise
    out["edited" if editing else "regenerated"] = True
    return out


# -- optional nudge after a long silence (lazy: evaluated when the chat history is opened/polled)

def _maybe_nudge(did: str) -> bool:
    try:
        if load_transferania_prefs(did).get("nudge") is not True:
            return False
        now = _now()
        dt = _local_dt(now)
        if not (NUDGE_WINDOW[0] <= (dt.hour, dt.minute) < NUDGE_WINDOW[1]):
            return False
        day = dt.strftime("%Y-%m-%d")
        with _lock:
            if _device_busy(did):
                return False
            data = load_transferania(did)
            if data.get("_unreadable") or data.get("nudge_day") == day:
                return False
            stamps = []
            for m in data.get("messages") or []:
                try:
                    stamps.append(float(m.get("ts")))
                except (AttributeError, TypeError, ValueError):
                    pass
            if not stamps or now - max(stamps) < NUDGE_SILENCE_S:
                return False
            line = NUDGE_LINES[int(now // 86400) % len(NUDGE_LINES)]
            data["messages"].append({"role": "assistant", "text": line, "ts": now, "kind": "nudge"})
            data["nudge_day"] = day
            save_transferania(data, did)
        return True
    except (AiError, OSError, ValueError, TypeError, OverflowError):
        return False


# -- cost / latency panel (read-only over context-usage.json; no extra writes)

def transferania_stats() -> dict:
    p = Path(_cb["root"]) / STORE / "context-usage.json"
    try:
        rows = json.loads(p.read_text("utf-8"))
        rows = rows if isinstance(rows, list) else []
    except (OSError, ValueError):
        rows = []
    chat = [r for r in rows if isinstance(r, dict) and r.get("reason") == "chat"]
    num = lambda v: isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)
    recent = []
    for r in chat[-STATS_RECENT:]:
        usage = [u for u in (r.get("provider_usage") or []) if isinstance(u, dict)]
        ok = next((u for u in reversed(usage) if u.get("status") == 200), None)
        attempts = r.get("provider_attempts") if num(r.get("provider_attempts")) else 0
        model = str(ok.get("model"))[:40] if ok else ("local" if not attempts else "échec")
        recent.append({"at": r.get("at") if num(r.get("at")) else None, "model": model,
                       "latency_ms": int(r["latency_ms"]) if num(r.get("latency_ms")) else None,
                       "cost": r.get("cost") if num(r.get("cost")) else None, "attempts": int(attempts)})
    lat = sorted(x["latency_ms"] for x in recent if x["latency_ms"] is not None and x["model"] != "local")
    median = None
    if lat:
        mid = len(lat) // 2
        median = lat[mid] if len(lat) % 2 else round((lat[mid - 1] + lat[mid]) / 2)
    today = _local_dt().strftime("%Y-%m-%d")
    cost_today, unpriced = 0.0, 0
    for r in chat:
        if not num(r.get("at")) or _local_dt(float(r["at"])).strftime("%Y-%m-%d") != today or not r.get("provider_attempts"):
            continue
        if num(r.get("cost")):
            cost_today += float(r["cost"])
        else:
            unpriced += 1
    mix: dict[str, int] = {}
    for x in recent:
        mix[x["model"]] = mix.get(x["model"], 0) + 1
    return {"ok": True, "recent": recent[::-1], "count": len(recent), "median_latency_ms": median,
            "cost_today": round(cost_today, 6), "cost_today_unpriced": unpriced, "model_mix": mix,
            "prices_configured": bool(companion_config().get("prices_per_million"))}

@companion_request("chat")
def transferania_chat(message: Any, view: Any = "", digest: Any = "", persona: Any = "warm", *, nsfw: bool = False, client_ip: Any = None, role: Any = None, signals: Any = None, device_id: Any = None, image: Any = None) -> dict:
    started = time.monotonic()
    did = normalize_device_id(device_id)
    mode = _resolve_persona(persona)
    use_nsfw = nsfw is True and nsfw_allowed(client_ip, role)
    if mode == "off" and not use_nsfw:
        raise AiError("Transferania est désactivée (personnalité off)", 400, "companion_off")
    inline_img = parse_chat_image(image)
    msg = re.sub(r"\s+", " ", str(message or "").strip())
    if not msg and inline_img:
        msg = "[Image partagée]"
    if not msg:
        raise AiError("Message vide")
    if len(msg) > TRANSFERANIA_MSG_MAX:
        raise AiError(f"Message trop long (max {TRANSFERANIA_MSG_MAX} caractères)")
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    if not inline_img and (_RECALL_RE.match(msg) or _REMEMBER_ADD_RE.match(msg) or _FORGET_RE.match(msg)):
        # Local memory commands: deterministic reply, no model call, no quota.
        current = load_transferania(did)
        if current.get("_unreadable"):
            raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
        command = _memory_command_reply(msg, did, str(current.get("summary") or ""))
        if command is not None:
            return _local_chat_reply(msg, command, did, view=v, mode=mode, nsfw=use_nsfw)
    key = (_api_keys() or [""])[0]
    if not key:
        raise AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
    if not transferania_ok():
        raise AiError("Quota de chat Transferania épuisé pour aujourd'hui", 429, "transferania_quota")
    if load_transferania(did).get("_unreadable"):
        raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
    prefs = load_transferania_prefs(did)
    page = append_companion_signals(gather_ambient(v, str(digest or "")), signals, prefs, device_id=did, nsfw=use_nsfw)
    st = _life_begin(did, v, signals)
    allow_social_continuity = companion_presence.classify(msg) == "social" and _shared_memory(companion_memory.continuity_allowed)
    with hq_life._lock:
        due = [e for e in hq_life.candidates(st) if e["kind"] == "ask_after"][:1] if allow_social_continuity else []
    page += "\n\n" + hq_life.time_block(st, VIEW_LABELS, consume=False)
    if due:
        page += "\n\n" + hq_life.event_block(due[0])
    remember = hq_life.upcoming_block(st)
    _shared_memory(companion_memory.migrate, did, load_transferania(did))
    resolved_followup = _shared_memory(companion_memory.observe_user, msg, did)
    with _lock:
        data = load_transferania(did)
        data.setdefault("messages", []).append({
            "role": "user", "text": msg, "ts": _now(), "view": v,
            **({"nsfw": True} if use_nsfw else {}),
            **({"has_image": True} if inline_img else {}),
        })
        maybe_compress(data)
        save_transferania(data, did)
        hist = list(data.get("messages") or [])
        summary = str(data.get("summary") or "").strip()
    life = hq_life.mood_label(st["mood"]) + ("\n" + remember if remember else "")
    system = _chat_system("nsfw" if use_nsfw else mode, nsfw=use_nsfw, view=v, device_id=did, prefs=prefs)
    chain = NSFW_CHAIN if use_nsfw else CHAT_CHAIN
    # Normal chat has an overall server deadline under the browser's 45 s; adult chat keeps its old limits.
    deadline = None if use_nsfw else started + CHAT_DEADLINE_S
    data = refresh_companion_summary(data, did, system, msg, page, limit=chain_floor_cap(chain),
                                     deadline=None if use_nsfw else started + CHAT_SUMMARY_WINDOW_S)
    groups = complete_exchanges(hist[:-1])
    prompt_history = [m for group in groups for m in group]
    packet = _continuity_packet(msg + " " + v + " " + str(data.get("summary") or ""), conversation_text=msg,
                               reserve_followup=not due, allow_followup=not due)
    previous_reply = next((m.get("text", "") for m in reversed(hist[:-1]) if m.get("role") == "assistant"), "")
    voice_guidance = companion_presence.delivery_hint(previous_reply, msg, packet["presence"], has_ritual=packet["ritual_available"])
    refl_hint = companion_reflection_hint(data, prefs, signals, msg)
    if refl_hint:
        voice_guidance = (voice_guidance + " " + refl_hint).strip() if voice_guidance else "VOIX TRANSFERANIA : " + refl_hint
    shared_memories, followup = packet["memories"], packet["continuity"]
    hq_lookup_text, hq_sources = hq_live_lookup_block(msg)
    arch_text = companion_archive.archive_block(msg, nsfw=use_nsfw, recent_messages=prompt_history[-8:])
    core = system
    evidence = dict(history=prompt_history,
        summary=str(data.get("summary") or ""), memories=shared_memories, corrections=packet.get("corrections", []), page=join_evidence_page(
            facts_block(did), packet["prompt"], life, resolved_followup,
            presence_page_block(prefs, signals, nsfw=use_nsfw),
            nsfw_evidence_page("chat") if use_nsfw else "",
            followup if not due else "", arch_text, hq_lookup_text,
            sister_awareness_block(did, "transferania"), page, voice_guidance))
    system, contents, _ = build_companion_context("chat", core, msg, **evidence)
    if inline_img and contents and contents[-1].get("role") == "user":
        contents[-1]["parts"].append({"inlineData": inline_img})
    _finalize_continuity_context(packet, contents)
    refits: dict[int, tuple[str, list]] = {}

    def refit(cap: int) -> tuple[str, list]:
        # Same priorities, smaller budget: a model with a smaller window (Gemma) gets the most important
        # evidence and the newest exchanges instead of being skipped.
        s_fit, c_fit = build_companion_context("chat", core, msg, budget=cap, record=False, **evidence)[:2]
        if inline_img and c_fit and c_fit[-1].get("role") == "user":
            c_fit[-1]["parts"].append({"inlineData": inline_img})
        refits[cap] = (s_fit, c_fit)
        return refits[cap]
    model = ""
    try:
        text, model = generate(
            chain,
            system,
            contents,
            temperature=0.97 if use_nsfw else 0.78,
            transferania=True,
            max_tokens=1536 if use_nsfw else 1024,
            nsfw=use_nsfw,
            refit=refit,
            deadline=deadline,
        )
        # A re-fitted prompt can drop the pending follow-up the main prompt carried: release it, or it
        # would count as offered although the model that answered never saw it.
        sent = refits.get(model_input_cap(model)) if estimate_context(system, contents) > model_input_cap(model) else None
        if sent is not None and packet["continuity"] and any(packet["continuity"] in p.get("text", "") for m in contents for p in m.get("parts", [])):
            _finalize_continuity_context(packet, sent[1])
    except AiError as e:
        if e.code == "transferania_quota":
            raise
        reply = "Je bug un peu — réessaie dans un instant."
        with _lock:
            data = load_transferania(did)
            data["messages"].append({"role": "assistant", "text": reply, "ts": _now(), "kind": "fallback"})
            maybe_compress(data)
            save_transferania(data, did)
            pub = transferania_public_messages(data)
            sum2 = str(data.get("summary") or "").strip()
        return {"ok": True, "reply": reply, "fallback": True, "messages": pub,
                "transferania_used": transferania_used(), "transferania_per_day": daily_limit("chat"), "persona": mode, "nsfw": use_nsfw,
                "has_summary": bool(sum2), "name": TRANSFERANIA_NAME, "device_id": did}
    photo_catalog = list_companion_chat_photo_ids() if use_nsfw else {}
    loop_catalog = list_companion_loop_ids() if use_nsfw else {}
    shaped, photo_id, loop_id, fx_id = extract_companion_chat_media(
        text.strip(), photo_allowed=photo_catalog, loop_allowed=loop_catalog, keep_paragraphs=True
    )
    # Segments come from the paragraph-preserving text; the stored/spoken reply stays flattened as before.
    reply = re.sub(r"\s+", " ", shaped).strip()
    # Preserve the complete generated reply; brevity belongs in the register, not a destructive slice.
    if not reply.replace("|||", "").strip():
        reply = shaped = "…"
    segments = split_reply_segments(shaped)
    _life_end(did, due[0] if due else None)
    thought_res = hq_life.record_thought(_owner_device(did), labels=VIEW_LABELS)
    if hq_life.wants_moments(msg):
        _companion_local.state["remember_message"] = msg
    warmth = bump_warmth(did, 3)
    _shared_memory(companion_memory.observe_reply, msg, reply, did)
    suggest_cap = wants_capture(msg)
    inline_props = extract_inline_proposals(msg) if suggest_cap else []
    with _lock:
        data = load_transferania(did)
        merge_thread_facts(data, msg, reply)
        asst: dict[str, Any] = {
            "role": "assistant", "text": reply, "ts": _now(), "kind": "chat", "view": v, "nsfw": use_nsfw,
            "model": model, "model_label": MODELS[model][0],
        }
        if photo_id:
            asst["photo"] = photo_id
        if loop_id:
            asst["loop"] = loop_id
        if fx_id:
            asst["fx"] = fx_id
        if suggest_cap:
            asst["suggest_capture"] = msg[:200]
        if inline_props:
            asst["proposals"] = inline_props
        data["messages"].append(asst)
        maybe_compress(data)
        save_transferania(data, did)
        summary = str(data.get("summary") or "").strip()
        pub = transferania_public_messages(data)
    out: dict[str, Any] = {
        "ok": True,
        "reply": reply,
        "expression": packet["expression"],
        "fallback": False,
        "model": model,
        "model_label": MODELS[model][0],
        "messages": pub,
        "has_summary": bool(summary),
        "transferania_used": transferania_used(),
        "transferania_per_day": daily_limit("chat"),
        "persona": "nsfw" if use_nsfw else mode,
        "nsfw": use_nsfw,
        "name": TRANSFERANIA_NAME,
        "device_id": did,
        "warmth": warmth,
        "thought": thought_res.get("thought") or "",
        **({"photo": photo_id} if photo_id else {}),
        **({"loop": loop_id} if loop_id else {}),
        **({"fx": fx_id} if fx_id else {}),
        **({"suggest_capture": msg[:200]} if suggest_cap else {}),
        **({"proposals": inline_props} if inline_props else {}),
        **({"sources": hq_sources} if hq_sources else {}),
    }
    if len(segments) > 1:
        out["reply_segments"] = segments
    if segments and "spawn" not in _cb:
        prewarm_segs = segments[:2]
        voice_style = str((packet.get("expression") or {}).get("voice") or "neutral")
        def _prewarm_voice() -> None:
            try:
                import hq_voice
                import hq_voice_phonon
                if hq_voice_phonon.route("transferania") == "phonon":
                    if hq_voice_phonon.daemon_ready("fr", timeout=0.15):
                        for seg in prewarm_segs:
                            hq_voice.synthesize(seg, language="fr", style=voice_style, character="transferania")
                elif hq_voice.daemon_ready(timeout=0.15):
                    for seg in prewarm_segs:
                        hq_voice.synthesize(seg, language="fr", style=voice_style)
            except Exception:
                pass
        hq_life.spawn(_prewarm_voice)
    return out


def _else_favor_meter(did: str, *, fresh: bool = True) -> dict:
    try:
        import hq_sister
        return hq_sister._master_favor_meter(did, fresh=fresh)
    except Exception:
        return {"favor": "tie", "tease": ""}


def _local_else_chat_reply(msg: str, reply: str, did: str, *, view: str, mode: str, nsfw: bool) -> dict:
    with _lock:
        data = load_else(did)
        if data.get("_unreadable"):
            raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
        now = _now()
        data.setdefault("messages", []).append({"role": "user", "text": msg, "ts": now, "view": view, **({"nsfw": True} if nsfw else {})})
        data["messages"].append({"role": "assistant", "text": reply[:TRANSFERANIA_MSG_MAX], "ts": now, "kind": "memory", "view": view})
        save_else(data, did)
        pub = transferania_public_messages(data)
        summary = str(data.get("summary") or "").strip()
    return {"ok": True, "reply": reply, "expression": None, "fallback": False, "local": True, "model": "local",
            "model_label": "Mémoire locale", "messages": pub, "has_summary": bool(summary),
            "transferania_used": transferania_used(), "transferania_per_day": daily_limit("chat"),
            "persona": "nsfw" if nsfw else mode, "nsfw": nsfw, "name": ELSE_NAME, "character": "else", "device_id": did,
            "meter": _else_favor_meter(did)}


@companion_request("chat")
def else_chat(message: Any, view: Any = "", digest: Any = "", persona: Any = "warm", *, nsfw: bool = False, client_ip: Any = None, role: Any = None, signals: Any = None, device_id: Any = None, character: str = "else") -> dict:
    """Else chip chat: shared ``build_companion_context`` pipeline, Else system + memory + thread stores."""
    started = time.monotonic()
    did = normalize_device_id(device_id)
    mode = _resolve_persona(persona)
    use_nsfw = nsfw is True and nsfw_allowed(client_ip, role)
    if mode == "off" and not use_nsfw:
        mode = "warm"
    msg = re.sub(r"\s+", " ", str(message or "").strip())
    if not msg:
        raise AiError("Message vide")
    if len(msg) > TRANSFERANIA_MSG_MAX:
        raise AiError(f"Message trop long (max {TRANSFERANIA_MSG_MAX} caractères)")
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    with companion_memory.memory_scope("else"):
        if _RECALL_RE.match(msg) or _REMEMBER_ADD_RE.match(msg) or _FORGET_RE.match(msg):
            current = load_else(did)
            if current.get("_unreadable"):
                raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
            command = _memory_command_reply(msg, did, str(current.get("summary") or ""))
            if command is not None:
                return _local_else_chat_reply(msg, command, did, view=v, mode=mode, nsfw=use_nsfw)
        if not (_api_keys() or [""])[0]:
            raise AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
        if not transferania_ok():
            raise AiError("Quota de chat Transferania épuisé pour aujourd'hui", 429, "transferania_quota")
        if load_else(did).get("_unreadable"):
            raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
        prefs = load_transferania_prefs(did)
        page = append_companion_signals(gather_ambient(v, str(digest or "")), signals, prefs, device_id=did, nsfw=use_nsfw)
        st = _life_begin(did, v, signals)
        page += "\n\n" + hq_life.time_block(st, VIEW_LABELS, consume=False)
        _shared_memory(companion_memory.migrate, did, load_else(did))
        resolved_followup = _shared_memory(companion_memory.observe_user, msg, did)
        with _lock:
            data = load_else(did)
            data.setdefault("messages", []).append({
                "role": "user", "text": msg, "ts": _now(), "view": v,
                **({"nsfw": True} if use_nsfw else {}),
            })
            maybe_compress(data)
            save_else(data, did)
            hist = list(data.get("messages") or [])
            summary = str(data.get("summary") or "").strip()
        system = build_else_system("chat", "nsfw" if use_nsfw else mode, nsfw=use_nsfw, view=v, device_id=did, prefs=prefs, context_core=True)
        chain = NSFW_CHAIN if use_nsfw else CHAT_CHAIN
        deadline = None if use_nsfw else started + CHAT_DEADLINE_S
        data = refresh_companion_summary(
            data, did, system, msg, page, limit=chain_floor_cap(chain),
            deadline=None if use_nsfw else started + CHAT_SUMMARY_WINDOW_S,
            load_fn=load_else, save_fn=save_else, assistant_name=ELSE_NAME,
        )
        groups = complete_exchanges(hist[:-1])
        prompt_history = [m for group in groups for m in group]
        packet = _continuity_packet(msg + " " + v + " " + str(data.get("summary") or ""), conversation_text=msg,
                                   reserve_followup=True, allow_followup=True)
        previous_reply = next((m.get("text", "") for m in reversed(hist[:-1]) if m.get("role") == "assistant"), "")
        voice_guidance = companion_presence.delivery_hint(previous_reply, msg, packet["presence"], has_ritual=packet["ritual_available"])
        if voice_guidance:
            voice_guidance = voice_guidance.replace("VOIX TRANSFERANIA", "VOIX ELSE")
        shared_memories, followup = packet["memories"], packet["continuity"]
        hq_lookup_text, hq_sources = hq_live_lookup_block(msg)
        core = system
        evidence = dict(history=prompt_history,
            summary=str(data.get("summary") or ""), memories=shared_memories, corrections=packet.get("corrections", []),
            page=join_evidence_page(
                facts_block(did), packet["prompt"], resolved_followup,
                presence_page_block(prefs, signals, nsfw=use_nsfw),
                nsfw_evidence_page("chat") if use_nsfw else "",
                followup or "", hq_lookup_text, sister_awareness_block(did, "else"), page, voice_guidance or ""))
        system, contents, _ = build_companion_context("chat", core, msg, **evidence)
        _finalize_continuity_context(packet, contents)
        refits: dict[int, tuple[str, list]] = {}

        def refit(cap: int) -> tuple[str, list]:
            s_fit, c_fit = build_companion_context("chat", core, msg, budget=cap, record=False, **evidence)[:2]
            refits[cap] = (s_fit, c_fit)
            return refits[cap]

        try:
            text, model = generate(
                chain, system, contents, temperature=0.85 if use_nsfw else 0.72,
                transferania=True, max_tokens=1024, nsfw=use_nsfw, refit=refit, deadline=deadline,
            )
            sent = refits.get(model_input_cap(model)) if estimate_context(system, contents) > model_input_cap(model) else None
            if sent is not None and packet["continuity"] and any(packet["continuity"] in p.get("text", "") for m in contents for p in m.get("parts", [])):
                _finalize_continuity_context(packet, sent[1])
        except AiError as e:
            if e.code == "transferania_quota":
                raise
            reply = "Je bug un peu — réessaie dans un instant."
            with _lock:
                data = load_else(did)
                data["messages"].append({"role": "assistant", "text": reply, "ts": _now(), "kind": "fallback"})
                maybe_compress(data)
                save_else(data, did)
                pub = transferania_public_messages(data)
                sum2 = str(data.get("summary") or "").strip()
            return {"ok": True, "reply": reply, "fallback": True, "messages": pub,
                    "transferania_used": transferania_used(), "transferania_per_day": daily_limit("chat"),
                    "persona": mode, "nsfw": use_nsfw, "has_summary": bool(sum2), "name": ELSE_NAME,
                    "character": "else", "device_id": did, "meter": _else_favor_meter(did)}
        reply = re.sub(r"\s+", " ", text.strip()).strip() or "…"
        _shared_memory(companion_memory.observe_reply, msg, reply, did)
        with _lock:
            data = load_else(did)
            merge_thread_facts(data, msg, reply)
            data["messages"].append({
                "role": "assistant", "text": reply, "ts": _now(), "kind": "chat", "view": v, "nsfw": use_nsfw,
                "model": model, "model_label": MODELS[model][0],
            })
            maybe_compress(data)
            save_else(data, did)
            summary = str(data.get("summary") or "").strip()
            pub = transferania_public_messages(data)
        try:
            import hq_else_handoff
            hq_else_handoff.maybe_export_after_chat(device_id=did, owner=companion_memory.current_owner())
        except Exception:
            pass
        return {
            "ok": True, "reply": reply, "expression": packet.get("expression"), "fallback": False,
            "model": model, "model_label": MODELS[model][0], "messages": pub, "has_summary": bool(summary),
            "transferania_used": transferania_used(), "transferania_per_day": daily_limit("chat"),
            "persona": "nsfw" if use_nsfw else mode, "nsfw": use_nsfw, "name": ELSE_NAME,
            "character": "else", "device_id": did, "meter": _else_favor_meter(did),
            **({"sources": hq_sources} if hq_sources else {}),
        }


def _else_soft_proactive(view: str) -> str:
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    pool = list(ELSE_PROACTIVE_SOFT)
    tagged = {
        "forge": "La Forge chauffe un peu. Je reste à portée.",
        "carnet": "Carnet ouvert — j'écoute sans presser.",
        "intime": "Intime. Je reste mesurée.",
        "lecteur": "Lecteur allumé — présence discrète.",
        "accueil": "Accueil calme. Je suis là.",
    }
    if v in tagged:
        pool = [tagged[v]] + pool
    return pool[int(_now() // 47) % len(pool)]


@companion_request("ambient")
def else_ambient(view: Any = "accueil", digest: Any = "", persona: Any = "warm", *, nsfw: bool = False,
                 client_ip: Any = None, role: Any = None, signals: Any = None, device_id: Any = None,
                 character: str = "else") -> dict:
    """Rare Else proactive aside — measured tone, ambient quota, soft fallback."""
    did = normalize_device_id(device_id)
    mode = _resolve_persona(persona)
    use_nsfw = nsfw is True and nsfw_allowed(client_ip, role)
    if mode == "off" and not use_nsfw:
        mode = "warm"
    v = re.sub(r"[^a-z0-9_-]", "", str(view or "accueil").lower())[:32] or "accueil"
    with companion_memory.memory_scope("else"):
        data = load_else(did)
        if data.get("_unreadable"):
            raise AiError(THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
        now = _now()
        try:
            last = float(data.get("last_ambient_at") or 0)
        except (TypeError, ValueError):
            last = 0.0
        prefs = load_transferania_prefs(did)
        if prefs.get("else_proactive") is False:
            return {
                "ok": True, "skipped": True, "reason": "disabled",
                "device_id": did, "name": ELSE_NAME, "character": "else",
            }
        cool = ELSE_CADENCE_COOLDOWN_S.get(str(prefs.get("else_proactive_cadence") or "normal"), ELSE_AMBIENT_COOLDOWN_S)
        if last and now - last < cool:
            return {
                "ok": True, "skipped": True, "reason": "cooldown",
                "retry_after": int(cool - (now - last)),
                "device_id": did, "name": ELSE_NAME, "character": "else",
            }
        soft = _else_soft_proactive(v)
        base = {
            "ambient_used": ambient_used(),
            "ambient_per_day": daily_limit("ambient"),
            "device_id": did,
            "name": ELSE_NAME,
            "character": "else",
            "persona": "nsfw" if use_nsfw else mode,
            "nsfw": use_nsfw,
        }
        key = (_api_keys() or [""])[0]
        # Prefer soft when no key / ambient budget — still marks presence.
        if not key or not ambient_ok() or (int(now * 1000) // 41) % 10 < 6:
            line = soft
            fallback = True
            model = None
        else:
            page = append_companion_signals(gather_ambient(v, str(digest or "")), signals, prefs, device_id=did, nsfw=use_nsfw)
            st = _life_begin(did, v, signals)
            page += "\n\n" + hq_life.time_block(st, VIEW_LABELS, consume=False)
            _shared_memory(companion_memory.migrate, did, data)
            summary = str(data.get("summary") or "").strip()
            system = build_else_system("ambient", "nsfw" if use_nsfw else mode, nsfw=use_nsfw, view=v, device_id=did, prefs=prefs, context_core=True)
            system += "\nAparté proactif rare : une phrase courte, ton Else (mesuré). Pas d'ordre, pas de drama. Le Maître peut ignorer."
            packet = _continuity_packet(page + " " + summary, reserve_followup=False, allow_followup=False)
            system, contents, _ = build_companion_context(
                "ambient", system, "Une observation brève si elle est pertinente — ton Else.",
                summary=summary, memories=packet["memories"], corrections=packet.get("corrections", []),
                page=join_evidence_page(packet["prompt"], sister_awareness_block(did, "else"), page),
            )
            try:
                text, model = generate(
                    NSFW_CHAIN if use_nsfw else AMBIENT_CHAIN,
                    system, contents,
                    temperature=0.82 if not use_nsfw else 0.9,
                    ambient=True, nsfw=use_nsfw, max_tokens=160,
                )
                line = re.sub(r"\s+", " ", (text or "").strip())[:AMBIENT_LINE_MAX] or soft
                fallback = False
                _life_end(did, None)
            except AiError:
                line = soft
                fallback = True
                model = None
                try:
                    _life_end(did, None)
                except Exception:
                    pass
        with _lock:
            data = load_else(did)
            data["last_ambient_at"] = now
            data.setdefault("messages", []).append({
                "role": "assistant", "text": line, "ts": now, "kind": "ambient", "view": v,
                **({"fallback": True} if fallback else {}),
                **({"model": model, "model_label": MODELS[model][0]} if model else {}),
            })
            maybe_compress(data)
            save_else(data, did)
            pub = transferania_public_messages(data)
        if not fallback:
            try:
                _shared_memory(companion_memory.observe_reply, "", line, did)
            except AiError:
                pass
        out = {
            "ok": True, "ambient": True, "line": line, "reply": line, "fallback": fallback,
            "messages": pub, **base,
        }
        if model:
            out["model"] = model
            out["model_label"] = MODELS[model][0]
        return out


def else_history(*, device_id: str, client_ip: Any = None, role: Any = None) -> dict:
    did = normalize_device_id(device_id)
    with companion_memory.memory_scope("else"):
        data = load_else(did)
        _shared_memory(companion_memory.migrate, did, data)
        summary = str(data.get("summary") or "").strip()
        msgs = data.get("messages") or []
        return {
            "ok": True,
            "name": ELSE_NAME,
            "character": "else",
            "device_id": did,
            "keep": thread_keep_limit(msgs),
            "has_summary": bool(summary),
            "summary_preview": summary[:240] if summary else "",
            "messages": transferania_public_messages(data),
            "prefs": load_transferania_prefs(did),
            "transferania_used": transferania_used(),
            "transferania_per_day": daily_limit("chat"),
            "last_ambient_at": data.get("last_ambient_at") or None,
            "nsfw_allowed": nsfw_allowed(client_ip, role),
        }


def else_clear(*, device_id: str) -> dict:
    did = normalize_device_id(device_id)
    with _lock:
        load_else(did)
        save_else(_empty_transferania(), did)
    return {"ok": True, "cleared": True, "name": ELSE_NAME, "character": "else", "device_id": did}


def else_post(data: dict, *, client_ip: Any = None, role: Any = None) -> dict:
    op = str(data.get("op") or "send").strip().lower()
    if op in ("handoff", "export_handoff"):
        import hq_else_handoff
        did = None
        try:
            did = device_id_from(data)
        except AiError:
            pass
        return hq_else_handoff.export_else_handoff(
            device_id=did,
            owner=str(companion_memory.current_owner() or "admin"),
            gemini_root=data.get("gemini_root"),
            dry_run=data.get("dry_run") is True,
        )
    did = device_id_from(data)
    if op in ("clear", "reset", "forget"):
        return else_clear(device_id=did)
    if op in ("history", "get", "load"):
        return else_history(device_id=did, client_ip=client_ip, role=role)
    if op == "prefs":
        keys = (
            "else_proactive", "else_proactive_cadence", "else_voice",
            "else_address", "else_topics_off", "address", "topics_off",
        )
        if data.get("save") is True or isinstance(data.get("prefs"), dict):
            payload = data.get("prefs") if isinstance(data.get("prefs"), dict) else {k: data.get(k) for k in keys if k in data}
            return {"ok": True, "prefs": save_transferania_prefs(payload, did), "device_id": did, "character": "else"}
        return {"ok": True, "prefs": load_transferania_prefs(did), "device_id": did, "character": "else"}
    if op in ("memory", "memory_forget", "memory_correct", "memory_remember", "memory_add"):
        if role not in (None, "admin"):
            raise AiError("Mémoire réservée à la session administrateur", 403, "forbidden")
        with companion_memory.memory_scope("else"):
            _shared_memory(companion_memory.migrate, did, load_else(did))
            try:
                if op == "memory_forget":
                    return {**_shared_memory(companion_memory.forget, str(data.get("id") or "")), "character": "else"}
                if op == "memory_correct":
                    return {
                        **_shared_memory(companion_memory.correct, str(data.get("id") or ""), data.get("text")),
                        "character": "else",
                    }
                if op in ("memory_remember", "memory_add"):
                    text = str(data.get("text") or data.get("message") or "").strip()
                    if not text:
                        raise AiError("Souvenir vide", 400, "memory_empty")
                    _shared_memory(companion_memory.remember_fact, text, did)
                    snap = _shared_memory(companion_memory.snapshot)
                    return {"ok": True, "character": "else", "device_id": did, "remembered": True, **snap}
                snap = _shared_memory(companion_memory.snapshot)
                return {"ok": True, "character": "else", "device_id": did, **snap}
            except ValueError as error:
                if isinstance(error, AiError):
                    raise
                raise AiError(str(error), 400, "memory_validation") from error
    if op in ("voice", "speak", "tts"):
        import hq_voice
        text = str(data.get("text") or data.get("message") or "")
        res = hq_voice.synthesize(text, language=data.get("language", "fr"), style=data.get("style") or "thoughtful")
        if res and res.get("ok"):
            return {"ok": True, "device_id": did, "character": "else", "quiet": True, **res}
        return {"ok": False, "error": (res.get("error") if res else "Synthèse vocale indisponible"), "device_id": did, "character": "else"}
    if op in ("ambient", "proactive", "aside"):
        return else_ambient(
            data.get("view"),
            data.get("digest"),
            data.get("persona"),
            nsfw=data.get("nsfw") is True,
            client_ip=client_ip,
            role=role,
            signals=data.get("signals"),
            device_id=did,
            character="else",
        )
    if op == "send":
        return else_chat(
            data.get("message") or data.get("text"),
            data.get("view"),
            data.get("digest"),
            data.get("persona"),
            nsfw=data.get("nsfw") is True,
            client_ip=client_ip,
            role=role,
            signals=data.get("signals"),
            device_id=did,
            character="else",
        )
    raise AiError("Opération Else inconnue (op: send, ambient, prefs, memory, voice, history, clear)")


def sister_awareness_block(device_id: str, for_character: str) -> str:
    import hq_sister
    return hq_sister.awareness_block(device_id, for_character=for_character)


def load_sister_dialogue(device_id: str) -> dict:
    import hq_sister
    return hq_sister.load_dialogue(device_id)


def save_sister_dialogue(data: dict, device_id: str) -> None:
    import hq_sister
    hq_sister.save_dialogue(data, device_id)


def sister_history(*, device_id: str) -> dict:
    import hq_sister
    return hq_sister.history(device_id=device_id)


def sister_clear(*, device_id: str) -> dict:
    import hq_sister
    return hq_sister.clear(device_id=device_id)


@companion_request("chat")
def sister_exchange(topic: Any = "", *, turns: Any = 2, view: Any = "accueil", nsfw: bool = False,
                    ambient: bool = False, client_ip: Any = None, role: Any = None, device_id: Any = None,
                    character: str = "sister") -> dict:
    import hq_sister
    return hq_sister.exchange(
        topic, turns=turns, view=view, nsfw=nsfw, ambient=ambient,
        client_ip=client_ip, role=role, device_id=device_id, character=character,
    )


@companion_request("chat")
def sister_react(*, trigger: Any = "", speaker: Any = "else", view: Any = "accueil", nsfw: bool = False,
                 client_ip: Any = None, role: Any = None, device_id: Any = None, character: str = "sister") -> dict:
    import hq_sister
    return hq_sister.react(
        trigger=trigger, speaker=speaker, view=view, nsfw=nsfw,
        client_ip=client_ip, role=role, device_id=device_id, character=character,
    )


def sister_post(data: dict, *, client_ip: Any = None, role: Any = None) -> dict:
    import hq_sister
    return hq_sister.http_post(data, client_ip=client_ip, role=role)


@companion_memory.owner_request
@companion_request("memory")
def _remember_moments(msg: str, *, device_id: str, owner_id: Any = None) -> None:
    """A dated thing that matters (« mon exam de statique jeudi ») is kept so she can ask about it the day after."""
    try:
        system, contents, _ = build_companion_context("chat", hq_life.MOMENT_SYSTEM.format(today=_today_text()), msg[:1200])
        text, _ = generate(CAPTURE_CHAIN, system, contents,
                           json_out=True, temperature=0.1, transferania=True, max_tokens=300, background=True)
        moments = hq_life.add_moments(_owner_device(device_id), extract_json(text))
        if moments:
            _shared_memory(companion_memory.remember_moments, moments, msg, device_id)
    except (AiError, ValueError):
        pass


def transferania_post(data: dict, *, client_ip: Any = None, role: Any = None) -> dict:
    did = device_id_from(data)
    op = str(data.get("op") or "send").strip().lower()
    if op in ("personality", "personality_save", "personality_reset", "context_preview"):
        if role != "admin":
            raise AiError("Éditeur réservé à la session administrateur", 403, "forbidden")
        try:
            if op == "context_preview":
                return companion_context_preview(data, client_ip=client_ip, role=role)
            if op == "personality":
                return _shared_memory(companion_memory.personality_snapshot)
            if op == "personality_save":
                traits = companion_memory.validate_personality(data.get("traits"))
                for channel in ("chat", "ambient"):
                    for mode in ("warm", "flirt"):
                        for adult in (False, True) if nsfw_allowed(client_ip, role) else (False,):
                            system = build_transferania_system(channel, mode, nsfw=adult, view="accueil", device_id=did,
                                context_core=True, trait_overrides=traits)
                            if estimate_context(system, [{"role": "user", "parts": [{"text": "Bonjour."}]}]) > context_budget(channel):
                                raise AiError("Ces traits dépassent le budget de contexte. Raccourcis-les avant d'enregistrer.", 413, "context_budget")
            return _shared_memory(companion_memory.save_personality, data.get("traits"), data.get("revision"), reset=op == "personality_reset")
        except ValueError as error:
            if isinstance(error, AiError):
                raise
            raise AiError(str(error), 400, "editor_validation") from error
    if op in ("memory", "memory_forget", "memory_correct", "episode_correct", "followup_close"):
        if role not in (None, "admin"):
            raise AiError("Mémoire réservée à la session administrateur", 403, "forbidden")
        _shared_memory(companion_memory.migrate, did, load_transferania(did))
        try:
            if op == "memory_forget":
                return _shared_memory(companion_memory.forget, str(data.get("id") or ""))
            if op == "memory_correct":
                return _shared_memory(companion_memory.correct, str(data.get("id") or ""), data.get("text"))
            if op == "episode_correct":
                return _shared_memory(companion_memory.correct_episode, str(data.get("id") or ""), data.get("text"), data.get("revision"))
            if op == "followup_close":
                return _shared_memory(companion_memory.close_followup, str(data.get("id") or ""))
            return _shared_memory(companion_memory.snapshot)
        except ValueError as error:
            if isinstance(error, AiError):
                raise
            raise AiError(str(error), 400, "memory_validation") from error
    if op in ("facts", "fact_add", "fact_edit", "fact_delete", "backups", "backup_restore"):
        if role not in (None, "admin"):
            raise AiError("Mémoire réservée à la session administrateur", 403, "forbidden")
        if op == "fact_add":
            return add_fact(data.get("text"), did)
        if op == "fact_edit":
            return edit_fact(data.get("id"), data.get("text"), did)
        if op == "fact_delete":
            return delete_fact(data.get("id"), did)
        if op == "backups":
            return list_thread_backups(did)
        if op == "backup_restore":
            return restore_thread_backup(data.get("name"), did)
        st = load_facts(did)
        return {"ok": True, "facts": st["facts"], "unreadable": st["unreadable"], "max": FACTS_MAX, "device_id": did}
    if op in ("regenerate", "retry"):
        return transferania_rewind(data, did=did, client_ip=client_ip, role=role)
    if op == "edit_last":
        return transferania_rewind(data, did=did, client_ip=client_ip, role=role,
                                   edit_text=data.get("message") or data.get("text") or "")
    if op in ("stats",):
        return {**transferania_stats(), "device_id": did}
    if op in ("briefing", "atelier"):
        return transferania_briefing(did)
    if op in ("thoughts", "journal"):
        res = hq_life.record_thought(_owner_device(did), labels=VIEW_LABELS)
        return {"ok": True, "thought": res["thought"], "current": res["thought"], "thoughts": res["thoughts"][-8:], "device_id": did}
    if op in ("thought_add",):
        res = hq_life.record_thought(_owner_device(did), data.get("text"), kind=str(data.get("kind") or "note"), labels=VIEW_LABELS)
        return {"ok": True, "thought": res["thought"], "current": res["thought"], "thoughts": res["thoughts"][-8:], "device_id": did}
    if op in ("souvenirs",):
        return {"ok": True, "souvenirs": load_souvenirs(did), "max": SOUVENIRS_MAX, "device_id": did}
    if op in ("souvenir_pin",):
        return pin_souvenir(data, did)
    if op in ("souvenir_delete",):
        return delete_souvenir(data.get("id"), did)
    if op in ("archive_search",):
        return {"ok": True, "results": companion_archive.search_archive(str(data.get("q") or data.get("query") or ""), nsfw=data.get("nsfw") is True and nsfw_allowed(client_ip, role)), "device_id": did}
    if op in ("clear", "reset", "forget"):
        return transferania_clear(device_id=did)
    if op in ("history", "get", "load"):
        return transferania_history(device_id=did, client_ip=client_ip, role=role)
    if op in ("voice_profiles", "voice_preview", "voice_save", "voice_reset", "voice_start"):
        import hq_voice_phonon
        return {**hq_voice_phonon.studio(op, data, admin=role in (None, "admin")), "device_id": did}
    if op in ("voice", "speak", "tts"):
        import hq_voice
        text = str(data.get("text") or data.get("message") or "")
        preset = data.get("preset")
        if preset and preset in hq_voice.SOUND_BANK_PRESETS:
            text = hq_voice.SOUND_BANK_PRESETS[preset]
        res = hq_voice.synthesize(text, language=data.get("language", "fr"), style=data.get("style", "neutral"),
                                  character="transferania")
        if res and res.get("ok"):
            return {"ok": True, "device_id": did, **res}
        return {"ok": False, "error": (res.get("error") if res else "Synthèse vocale indisponible"), "device_id": did,
                **({"engine": res["engine"]} if res and res.get("engine") else {})}
    if op == "prefs":
        if data.get("save") is True or isinstance(data.get("prefs"), dict):
            payload = data.get("prefs") if isinstance(data.get("prefs"), dict) else {k: data.get(k) for k in ("nickname", "address", "qc_dial", "intensity", "topics_off", "celebrate", "nudge") if k in data}
            return {"ok": True, "prefs": save_transferania_prefs(payload, did), "device_id": did}
        return {"ok": True, "prefs": load_transferania_prefs(did), "device_id": did}
    if op == "send":
        return transferania_chat(
            data.get("message") or data.get("text"),
            data.get("view"),
            data.get("digest"),
            data.get("persona"),
            nsfw=data.get("nsfw") is True,
            client_ip=client_ip,
            role=role,
            signals=data.get("signals"),
            device_id=did,
            image=data.get("image"),
        )
    raise AiError("Opération Transferania inconnue (op: send, history, clear, prefs)")


# ---------------------------------------------------------------- « Noter »

CAPTURE_SYSTEM = """Tu transformes UNE phrase de l'utilisateur en actions pour son tableau de bord. Aujourd'hui : {today} (fuseau local).
Réponds UNIQUEMENT en JSON : {{"actions": [ ... ], "reply": "une courte phrase en français"}} avec au plus 3 actions parmi :
- {{"kind":"event","title":"…","start":"AAAA-MM-JJTHH:MM","end":"AAAA-MM-JJTHH:MM","all_day":false,"category":"personal|study|appointment|maintenance|hq|other"}}
  (journée entière : "all_day":true, start et end en AAAA-MM-JJ, end = lendemain ; sans heure de fin, 1 h)
- {{"kind":"task","title":"…","project":"id du projet ou null","due":"AAAA-MM-JJ ou null"}}
- {{"kind":"project_note","project":"id du projet","text":"la note « Où j'en suis »","mode":"replace|append"}}
- {{"kind":"stock","item":"id de l'objet existant ou null","name":"nom si nouvel objet","delta":entier (+ ajouté, - utilisé),"unit":"","place":"id d'emplacement ou null"}}
  (objet existant : delta seulement ; nouvel objet : delta = quantité de départ)
- {{"kind":"note","text":"texte de la note pour le Carnet"}}
Utilise UNIQUEMENT les ids des listes ci-dessous. Si rien ne correspond à une action, renvoie "actions": [] et explique dans reply.
PROJETS : {projects}
OBJETS : {items}
EMPLACEMENTS : {places}"""


def _capture_lists(text: str) -> tuple[str, str, str, dict]:
    ws = words(text)
    pj = _cb["projects"]() or {}
    projects = [p for p in (pj.get("projects") or []) if isinstance(p, dict) and p.get("status") not in ("archived",)]
    inv = _cb["inventory"]() or {}
    places = [p for p in (inv.get("places") or []) if isinstance(p, dict)]
    paths = _place_paths(places)
    items = [i for i in (inv.get("items") or []) if isinstance(i, dict)]
    if len(items) > 80:
        items = sorted(items, key=lambda i: -score(f"{i.get('name')} {' '.join(i.get('tags') or [])}", ws))[:80]
    if len(places) > 80:
        places = sorted(places, key=lambda p: -score(paths.get(p["id"], ""), ws))[:80]
    lp = "; ".join(f"{p['id']}={p.get('name')}" for p in projects[:40]) or "(aucun)"
    li = "; ".join(f"{i['id']}={i.get('name')} ({i.get('qty')} {i.get('unit') or ''}, {paths.get(i.get('place')) or 'sans emplacement'})" for i in items) or "(aucun)"
    lpl = "; ".join(f"{p['id']}={paths.get(p['id'])}" + (f" [{p.get('code')}]" if p.get("code") else "") for p in places) or "(aucun)"
    world = {"projects": {p["id"]: p for p in pj.get("projects") or [] if isinstance(p, dict)},
             "items": {i["id"]: i for i in inv.get("items") or [] if isinstance(i, dict)},
             "places": {p["id"]: p for p in inv.get("places") or [] if isinstance(p, dict)}, "paths": paths}
    return lp, li, lpl, world


_MIN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def normalize(action: Any, world: dict) -> dict:
    """A proposal checked against what exists, with a French label for the confirmation card. Raises AiError."""
    if not isinstance(action, dict) or action.get("kind") not in KINDS:
        raise AiError("Action inconnue")
    k = action["kind"]
    s = lambda v, n=200: (str(v).strip()[:n] if isinstance(v, (str, int, float)) and str(v).strip() else "")  # noqa: E731
    if k == "event":
        title = s(action.get("title"), 140)
        all_day = action.get("all_day") is True
        start, end = s(action.get("start"), 16), s(action.get("end"), 16)
        if not title:
            raise AiError("Événement sans titre")
        if all_day:
            start, end = start[:10], end[:10]
            if not _DAY.match(start):
                raise AiError("Date invalide")
            if not _DAY.match(end) or end <= start:
                end = (datetime.strptime(start, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            if not _MIN.match(start):
                raise AiError("Heure invalide")
            if not _MIN.match(end) or end <= start:
                end = (datetime.strptime(start, "%Y-%m-%dT%H:%M") + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M")
        cat = action.get("category") if action.get("category") in ("personal", "study", "appointment", "maintenance", "hq", "other") else "other"
        when = start if all_day else start.replace("T", " ") + "–" + end[11:]
        return {"kind": k, "title": title, "start": start, "end": end, "all_day": all_day, "category": cat, "label": f"Événement · {title} · {when}"}
    if k == "task":
        title = s(action.get("title"), 140)
        if not title:
            raise AiError("Tâche sans titre")
        pid = action.get("project") if action.get("project") in world["projects"] else None
        due = s(action.get("due"), 10) if _DAY.match(s(action.get("due"), 10)) else None
        pname = world["projects"][pid]["name"] if pid else "Tâches libres"
        return {"kind": k, "title": title, "project": pid, "due": due, "label": f"Tâche · {title} · {pname}" + (f" · pour le {due}" if due else "")}
    if k == "project_note":
        pid = action.get("project")
        if pid not in world["projects"]:
            raise AiError("Projet introuvable")
        text = s(action.get("text"), 1000)
        if not text:
            raise AiError("Note vide")
        mode = "append" if action.get("mode") == "append" else "replace"
        return {"kind": k, "project": pid, "text": text, "mode": mode,
                "label": f"Où j'en suis · {world['projects'][pid]['name']} · {'ajout' if mode == 'append' else 'nouvelle note'} : {text}"}
    if k == "stock":
        delta = action.get("delta")
        if isinstance(delta, float) and delta.is_integer():
            delta = int(delta)
        if isinstance(delta, bool) or not isinstance(delta, int) or delta == 0 or abs(delta) > 1_000_000:
            raise AiError("Quantité invalide")
        iid = action.get("item")
        if iid in world["items"]:
            it = world["items"][iid]
            return {"kind": k, "item": iid, "delta": delta,
                    "label": f"Stock · {it.get('name')} {'+' if delta > 0 else '−'}{abs(delta)} (→ {max(0, int(it.get('qty') or 0) + delta)})"}
        name = s(action.get("name"), 80)
        if not name or delta < 0:
            raise AiError("Objet introuvable")
        place = action.get("place") if action.get("place") in world["places"] else None
        unit = s(action.get("unit"), 20)
        return {"kind": k, "item": None, "name": name, "delta": delta, "unit": unit, "place": place,
                "label": f"Nouvel objet · {name} × {delta}{(' ' + unit) if unit else ''} · {world['paths'].get(place) if place else 'sans emplacement'}"}
    text = s(action.get("text"), 4000)
    if not text:
        raise AiError("Note vide")
    return {"kind": "note", "text": text, "label": "Note du Carnet · " + text[:120] + ("…" if len(text) > 120 else "")}


def capture(text: Any) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise AiError("Phrase vide")
    text = text.strip()[:Q_MAX]
    lp, li, lpl, world = _capture_lists(text)
    system = CAPTURE_SYSTEM.format(today=_today_text(), projects=lp, items=li, places=lpl)
    out, model = generate(CAPTURE_CHAIN, system, [{"role": "user", "parts": [{"text": text}]}], json_out=True, temperature=0.1)
    data = extract_json(out)
    raw = data.get("actions") if isinstance(data, dict) else data if isinstance(data, list) else []
    proposals, refused = [], []
    for a in (raw or [])[:3]:
        try:
            proposals.append(normalize(a, world))
        except AiError as e:
            refused.append(str(e))
    reply = str(data.get("reply") or "")[:300] if isinstance(data, dict) else ""
    return {"ok": True, "proposals": proposals, "refused": refused, "reply": reply, "model": model, "model_label": MODELS[model][0]}


def apply_one(p: dict, world: dict) -> dict:
    """Write one confirmed proposal through its own module. Returns {kind, label, href}."""
    p = normalize(p, world)  # re-checked: the list may have changed since the proposal
    k = p["kind"]
    if k == "event":
        _cb["save_event"]({"title": p["title"], "start": p["start"], "end": p["end"], "all_day": p["all_day"], "category": p["category"]})
        return {"kind": k, "label": p["label"], "href": "#calendrier"}
    if k == "task":
        _cb["projects_apply"]({"action": "task.create", "title": p["title"], **({"project": p["project"]} if p["project"] else {}), **({"due": p["due"]} if p["due"] else {})})
        return {"kind": k, "label": p["label"], "href": "#projets/" + (p["project"] or "libres")}
    if k == "project_note":
        cur = world["projects"][p["project"]].get("resume") or ""
        text = (cur + "\n" + p["text"]).strip()[-1000:] if p["mode"] == "append" and cur else p["text"]
        _cb["projects_apply"]({"action": "project.resume", "id": p["project"], "text": text})
        return {"kind": k, "label": p["label"], "href": "#projets/" + p["project"]}
    if k == "stock":
        if p["item"]:
            _cb["inventory_apply"]({"action": "item.adjust", "id": p["item"], "delta": p["delta"]})
            return {"kind": k, "label": p["label"], "href": "#inventaire/objet/" + p["item"]}
        out = _cb["inventory_apply"]({"action": "item.create", "name": p["name"], "qty": p["delta"], "unit": p["unit"], "place": p["place"]})
        iid = ((out or {}).get("item") or {}).get("id")
        return {"kind": k, "label": p["label"], "href": "#inventaire/objet/" + iid if iid else "#inventaire"}
    page = _cb["carnet_note"]([ln for ln in p["text"].split("\n")][:200]) or {}
    return {"kind": k, "label": p["label"], "href": "#carnet/" + page["id"] + "/" + page["block"] if page.get("id") and page.get("block") else "#carnet"}


def apply(proposals: Any) -> dict:
    if not isinstance(proposals, list) or not proposals or len(proposals) > 3:
        raise AiError("Rien à enregistrer")
    _, _, _, world = _capture_lists("")
    done, failed = [], []
    for p in proposals:
        try:
            done.append(apply_one(p, world))
        except Exception as e:  # each module raises its own error type; the message is already French
            failed.append({"label": (p.get("label") if isinstance(p, dict) else "") or "Action", "error": str(e)[:200]})
    return {"ok": bool(done), "done": done, "failed": failed}


# ---------------------------------------------------------------- preview (tuning, localhost admin — optional live sample)

def companion_context_preview(data: dict, *, client_ip=None, role=None) -> dict:
    """Owner-authenticated local assembly only: no generation, migration or writes."""
    if role != "admin":
        raise AiError("Aperçu réservé administrateur", 403, "forbidden")
    did = device_id_from(data)
    channel = str(data.get("kind") or "chat")
    if channel not in {"chat", "ambient"}:
        raise AiError("Type d'aperçu invalide")
    message = re.sub(r"\s+", " ", str(data.get("message") or "").strip()) if channel == "chat" else "Une observation brève si elle est pertinente."
    if not message or len(message) > TRANSFERANIA_MSG_MAX:
        raise AiError(f"Message requis (max {TRANSFERANIA_MSG_MAX} caractères)")
    mode = _resolve_persona(data.get("persona") or "warm")
    nsfw = data.get("nsfw") is True and nsfw_allowed(client_ip, role)
    if mode == "off" and not nsfw:
        raise AiError("Transferania est désactivée", 400, "companion_off")
    view = re.sub(r"[^a-z0-9_-]", "", str(data.get("view") or "accueil").lower())[:32] or "accueil"
    thread = load_transferania(did)
    prefs = load_transferania_prefs(did)
    summary = str(thread.get("summary") or "")
    state = hq_life.load(_owner_device(did))
    page = append_companion_signals(gather_ambient(view, str(data.get("digest") or "")), data.get("signals"), prefs, device_id=did, nsfw=nsfw)
    page += "\n\n" + hq_life.time_block(state, VIEW_LABELS, consume=False)
    packet = _shared_memory(companion_memory.context_packet, message + " " + view + " " + summary,
        conversation_text=message if channel == "chat" else None, reserve_followup=False)
    voice_guidance = ""
    if channel == "chat":
        previous_reply = next((m.get("text", "") for m in reversed(thread.get("messages") or []) if m.get("role") == "assistant"), "")
        voice_guidance = companion_presence.delivery_hint(previous_reply, message, packet["presence"], has_ritual=packet["ritual_available"])
        refl_hint = companion_reflection_hint(thread, prefs, data.get("signals"), message)
        if refl_hint:
            voice_guidance = (voice_guidance + " " + refl_hint).strip() if voice_guidance else "VOIX TRANSFERANIA : " + refl_hint
    system = build_transferania_system(channel, "nsfw" if nsfw and channel == "chat" else mode,
        nsfw=nsfw, view=view, device_id=did, prefs=prefs, context_core=True)
    groups = complete_exchanges(thread.get("messages") or []) if channel == "chat" else []
    history = [m for group in groups for m in group]
    saved_state = getattr(_companion_local, "state", None)
    try:
        _companion_local.state = None
        system, contents, info = build_companion_context(channel, system, message,
            history=history, summary=summary, memories=packet["memories"], corrections=packet.get("corrections", []),
            page=join_evidence_page(
                packet["prompt"], hq_life.mood_label(hq_life.mood(state)), hq_life.upcoming_block(state),
                presence_page_block(prefs, data.get("signals"), nsfw=nsfw),
                nsfw_evidence_page(channel) if nsfw else "",
                packet["continuity"], recent_said_block(did) if channel == "ambient" else "", page, voice_guidance))
    finally:
        _companion_local.state = saved_state
    return {"ok": True, "kind": channel, "system": system, "contents": contents, "context_usage": info,
            "model_calls": 0, "read_only": True, "expression": packet["expression"],
            "note": "Aperçu avec la mémoire actuelle. Le prochain envoi peut actualiser le résumé, l'heure et les événements."}

@companion_request("preview")
def _companion_preview_sample(system: str, contents: list, info: dict, *, device_id: str, nsfw: bool) -> dict:
    _companion_local.state.update(info)
    text, model = generate(AMBIENT_CHAIN, system, contents, temperature=0.92 if nsfw else 0.85, ambient=True)
    return {"sample": text[:AMBIENT_LINE_MAX], "model": model, "model_label": MODELS[model][0]}

def preview(data: Any, *, client_ip: Any = None, role: Any = None) -> dict:
    """Return system + user payload sent to the model; ``live: true`` runs one generation (uses quota)."""
    if str(role or "").strip().lower() != "admin":
        raise AiError("Preview réservé admin", 403, "forbidden")
    fn = _cb.get("client_is_controller")
    if not (callable(fn) and fn(str(client_ip or ""))):
        raise AiError("Preview seulement depuis le poste principal (127.0.0.1)", 403, "forbidden")
    if not isinstance(data, dict):
        raise AiError("Requête invalide")
    kind = str(data.get("kind") or "ambient").strip().lower()
    nsfw = data.get("nsfw") is True
    use_nsfw = nsfw and nsfw_allowed(client_ip, role)
    live = data.get("live") is True
    out: dict[str, Any] = {"ok": True, "kind": kind, "nsfw_active": use_nsfw, "nsfw_allowed": nsfw_allowed(client_ip, role)}
    if kind == "ask":
        q = str(data.get("q") or "Qu'est-ce qui me rendrait chaud ce soir d'après mon HQ ?").strip()[:Q_MAX]
        context, sources = gather(q)
        system = ASK_SYSTEM.format(today=_today_text())
        if use_nsfw:
            system += ASK_NSFW_SUFFIX
        user = f"CONTEXTE\n{context or '(vide)'}\n\nQUESTION\n{q}"
        out.update({"system": system, "user": user[:8000], "sources": sources[:8]})
        if live:
            text, model = generate(DEEP_CHAIN if data.get("deep") else ASK_CHAIN, system,
                                     [{"role": "user", "parts": [{"text": user}]}], temperature=0.9 if use_nsfw else 0.3)
            out.update({"sample": text[:6000], "model": model, "model_label": MODELS[model][0]})
        return out
    view = re.sub(r"[^a-z0-9_-]", "", str(data.get("view") or "fichiers").lower())[:32] or "fichiers"
    digest = str(data.get("digest") or "Vue : Fichiers\nTitre : Inbox\nÉléments visibles : 12")[:AMBIENT_DIGEST_MAX]
    did = device_id_from(data)
    prefs = load_transferania_prefs(did)
    ctx = append_companion_signals(gather_ambient(view, digest), data.get("signals"), prefs, device_id=did, nsfw=use_nsfw)
    mode = _resolve_persona(data.get("persona") or "flirt")
    summary = str(load_transferania(did).get("summary") or "").strip()
    system = build_transferania_system("ambient", mode, nsfw=use_nsfw, view=view, device_id=did, prefs=prefs, context_core=True)
    packet = _continuity_packet(ctx + " " + summary)
    shared_memories, followup = packet["memories"], packet["continuity"]
    system, contents, context_usage = build_companion_context("ambient", system, "Une observation brève si elle est pertinente.",
        summary=summary, memories=shared_memories, corrections=packet.get("corrections", []),
        page=join_evidence_page(packet["prompt"], followup, recent_said_block(did), ctx))
    _finalize_continuity_context(packet, contents)
    included = bool(followup and followup in contents[-1]["parts"][0]["text"])
    context_usage.update(conversation_mode=packet["presence"]["mode"], continuity_kind=packet["presence"]["continuity_kind"] if included else "none",
                         selected_episode_count=packet["selected_episode_count"] if included else 0)
    out.update({"system": system, "user": contents[-1]["parts"][0]["text"], "view": view, "persona": "nsfw" if use_nsfw else mode, "context_usage": context_usage})
    if live:
        out.update(_companion_preview_sample(system, contents, context_usage, device_id=did, nsfw=use_nsfw))
    return out


# ---------------------------------------------------------------- HTTP

def status(client_ip: Any = None, role: Any = None, *, device_id: Any = None) -> dict:
    key = (_api_keys() or [""])[0]
    u = usage()
    cap = str(_cb["companion_persona"]() if callable(_cb.get("companion_persona")) else "warm").strip().lower()
    if cap not in ("off", "warm", "flirt"):
        cap = "warm"
    allow_nsfw, nsfw_block = nsfw_gate(client_ip, role)
    session_admin = str(role or "").strip().lower() == "admin"
    mem_summary = ""
    msg_n = 0
    personality = default_transferania_prefs()
    did_out = None
    t_keep = TRANSFERANIA_KEEP
    if device_id:
        try:
            did = normalize_device_id(device_id)
            mem = load_transferania(did)
            mem_summary = str(mem.get("summary") or "").strip()
            msg_n = len(mem.get("messages") or [])
            personality = load_transferania_prefs(did)
            did_out = did
            t_keep = thread_keep_limit(mem.get("messages") or [])
        except AiError:
            pass
    else_summary = {
        "name": ELSE_NAME,
        "configured": bool(key),
        "messages": 0,
        "has_summary": False,
    }
    if did_out:
        try:
            with companion_memory.memory_scope("else"):
                em = load_else(did_out)
            else_summary["messages"] = len(em.get("messages") or [])
            else_summary["has_summary"] = bool(str(em.get("summary") or "").strip())
        except Exception:
            pass
    import hq_sister
    sister_summary = hq_sister.status_snapshot(did_out)
    return {"ok": True, "configured": bool(key),
            "companion_cap": cap,
            "name": TRANSFERANIA_NAME,
            "nsfw_allowed": allow_nsfw,
            "nsfw_block": nsfw_block or None,
            "session_admin": session_admin,
            "device_id": did_out,
            "ambient": {"used": ambient_used(), "per_day": daily_limit("ambient")},
            "transferania": {"used": transferania_used(), "per_day": daily_limit("chat"), "keep": t_keep,
                             "messages": msg_n,
                             "has_summary": bool(mem_summary)},
            "else": else_summary,
            "sister": sister_summary,
            "personality": personality,
            "keys": max(1, len(_api_keys())),
            # per_day/used add up every key's own quota; the minute view is key 1 (each key has its own window).
            "models": [{"id": m, "label": v[0], "per_day": v[2] * max(1, len(_api_keys())),
                        "used": sum(int(u["count"].get(quota_slot(m, i), 0)) for i in range(max(1, len(_api_keys())))),
                        "per_minute": v[1], **model_minute_usage(m, u)} for m, v in MODELS.items()]}


@companion_memory.owner_request
def http_get(qs: dict, *, client_ip: Any = None, role: Any = None, owner_id: Any = None) -> tuple[int, dict]:
    try:
        flag = (qs.get("transferania") or [""])[0] if isinstance(qs, dict) else ""
        if str(flag).lower() in ("1", "true", "history"):
            return 200, transferania_history(device_id=device_id_from(None, qs), client_ip=client_ip, role=role)
        else_flag = (qs.get("else") or [""])[0] if isinstance(qs, dict) else ""
        if str(else_flag).lower() in ("1", "true", "history"):
            return 200, else_history(device_id=device_id_from(None, qs), client_ip=client_ip, role=role)
        dev = (qs.get("device_id") or [""])[0] if isinstance(qs, dict) else ""
        return 200, status(client_ip, role, device_id=dev or None)
    except AiError as error:
        return error.status, {"error": str(error), "code": error.code}


@companion_memory.owner_request
def http_post(data: Any, *, client_ip: Any = None, role: Any = None, owner_id: Any = None) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise AiError("Requête invalide")
        a = data.get("action")
        if a == "ask":
            hist = data.get("history") if isinstance(data.get("history"), list) else []
            return 200, ask(data.get("q"), hist, deep=data.get("deep") is True, nsfw=data.get("nsfw") is True, client_ip=client_ip, role=role)
        if a == "capture":
            return 200, capture(data.get("text"))
        if a == "apply":
            out = apply(data.get("proposals"))
            return (200 if out["ok"] else 400), out
        if a == "ambient":
            out = ambient(data.get("view"), data.get("digest"), data.get("persona"), nsfw=data.get("nsfw") is True, client_ip=client_ip, role=role,
                          signals=data.get("signals"), device_id=data.get("device_id"), event_id=data.get("event_id"))
            return 200, hq_pronunciation.enrich(out, str(data.get("pronunciation_language") or "auto"))
        if a == "pulse":
            return 200, pulse(data.get("view"), device_id=data.get("device_id"))
        if a == "transferania":
            out = transferania_post(data, client_ip=client_ip, role=role)
            return 200, hq_pronunciation.enrich(out, str(data.get("pronunciation_language") or "auto"))
        if a == "else":
            out = else_post(data, client_ip=client_ip, role=role)
            return 200, hq_pronunciation.enrich(out, str(data.get("pronunciation_language") or "auto"))
        if a == "sister":
            out = sister_post(data, client_ip=client_ip, role=role)
            return 200, hq_pronunciation.enrich(out, str(data.get("pronunciation_language") or "auto"))
        if a == "pronunciation":
            if role not in (None, "admin"):
                raise AiError("Accès refusé", status=403)
            plan = hq_pronunciation.pronunciation(str(data.get("text") or ""), str(data.get("language") or "auto"))
            return 200, {"ok": True, "pronunciation": plan, "available": plan is not None}
        if a == "preview":
            return 200, preview(data, client_ip=client_ip, role=role)
        raise AiError("Action inconnue")
    except AiError as e:
        return e.status, {"error": str(e), "code": e.code}
