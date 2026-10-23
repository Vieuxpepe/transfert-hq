"""Forge Studio phase J1: prompt bricks, with optional LoRA and trigger words.

A brick is a short reusable piece of prompt the owner types once (a name, a text, maybe a
LoRA with a weight and its trigger words). Bricks are administrator UX data, stored in
``.hq-forge/bricks.json`` beside the presets. They are written only from the brick editor,
never from a prompt, and never in private mode: the page refuses to save a brick while the
private destination is chosen, and the server keeps no prompt, image or job reference.

Inserting a brick only fills the prompt field in the page; nothing here starts a job.

Trigger word suggestions come from this PC's Forge through the already allowlisted, read-only
GET /sdapi/v1/loras (training tag counts in the file's own metadata, ss_tag_frequency). They
are only suggestions; the owner picks which words to keep. No worker is asked and no new
Forge route is used.

A missing file is an empty list. A malformed file is left untouched and blocks writes.
"""

from __future__ import annotations

import json
import math
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

import hq_forge as forge

VERSION = 1
MAX_BRICKS = 60
MAX_NAME = 60
MAX_TEXT = 400
MAX_LORA = 120
MAX_WORD = 60
MAX_WORDS = 8
MAX_SUGGESTED = 6
MAX_LORAS = 200
_ID = re.compile(r"^brick-[0-9a-f]{16}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f-\x9f]")
# A LoRA name goes inside <lora:NAME:WEIGHT>: no angle brackets or colons.
_LORA_BAD = re.compile(r"[<>:\x00-\x1f\x7f-\x9f]")
_WORD_BAD = re.compile(r"[<>,\x00-\x1f\x7f-\x9f]")
_LOCK = threading.Lock()

MESSAGES = {
    "validation": "Cette brique n'est pas accept\u00e9e.",
    "missing": "Cette brique n'existe pas.",
    "duplicate": "Ce nom est d\u00e9j\u00e0 utilis\u00e9.",
    "full": "La liste de briques est pleine.",
    "malformed": "Le fichier de briques est illisible. Il n'a pas \u00e9t\u00e9 remplac\u00e9.",
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _path(root: Path) -> Path:
    folder = Path(root) / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "bricks.json"


def _line(value, limit: int, *, required: bool) -> str | None:
    if value is None or value == "":
        return None if required else ""
    if not isinstance(value, str):
        return None
    value = value.strip()
    if (required and not value) or len(value) > limit or _CONTROL.search(value):
        return None
    return value


def _words(value) -> list | None:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_WORDS:
        return None
    out = []
    for item in value:
        if not isinstance(item, str):
            return None
        item = item.strip()
        if not item or len(item) > MAX_WORD or _WORD_BAD.search(item):
            return None
        if item.casefold() not in {w.casefold() for w in out}:
            out.append(item)
    return out


def _lora(value) -> dict | None | bool:
    """None = no LoRA; False = invalid; else {name, weight}."""
    if value is None:
        return None
    if not isinstance(value, dict):
        return False
    name = value.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > MAX_LORA or _LORA_BAD.search(name):
        return False
    weight = value.get("weight", 1)
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(float(weight)):
        return False
    weight = round(float(weight), 2)
    if not -2.0 <= weight <= 2.0:
        return False
    return {"name": name.strip(), "weight": weight}


def _parse(data: dict, *, brick_id: str) -> dict | None:
    name = _line(data.get("name"), MAX_NAME, required=True)
    text = _line(data.get("text"), MAX_TEXT, required=False)
    words = _words(data.get("triggers"))
    lora = _lora(data.get("lora"))
    if name is None or text is None or words is None or lora is False:
        return None
    if not text and not words and lora is None:
        return None  # an empty brick inserts nothing
    return {"id": brick_id, "name": name, "text": text, "lora": lora, "triggers": words, "updated": _now()}


def _valid_stored(item) -> dict | None:
    if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not _ID.fullmatch(item["id"]):
        return None
    parsed = _parse(item, brick_id=item["id"])
    if parsed is None:
        return None
    if isinstance(item.get("updated"), str) and len(item["updated"]) <= 40:
        parsed["updated"] = item["updated"]
    return parsed


def _read(root: Path) -> tuple[str, list]:
    path = _path(root)
    if not path.is_file():
        return "ready", []
    if path.is_symlink():
        return "malformed", []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "malformed", []
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("bricks"), list):
        return "malformed", []
    if len(data["bricks"]) > MAX_BRICKS:
        return "malformed", []
    bricks, seen, names = [], set(), set()
    for item in data["bricks"]:
        parsed = _valid_stored(item)
        if parsed is None or parsed["id"] in seen or parsed["name"].casefold() in names:
            return "malformed", []
        seen.add(parsed["id"])
        names.add(parsed["name"].casefold())
        bricks.append(parsed)
    return "ready", bricks


def _write(root: Path, bricks: list) -> None:
    path = _path(root)
    temporary = path.with_name("bricks.json.partial")
    payload = json.dumps({"version": VERSION, "bricks": bricks}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    try:
        with temporary.open("wb") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def _payload(bricks: list, storage: str = "ready") -> dict:
    return {"storage": storage, "bricks": bricks, "message": MESSAGES["malformed"] if storage == "malformed" else ""}


def list_bricks(root: Path) -> dict:
    with _LOCK:
        storage, bricks = _read(root)
    return _payload(bricks, storage)


def _error(status: int, code: str) -> tuple[int, dict]:
    return status, {"error": code, "message": MESSAGES[code]}


def _mutate(root: Path, data: dict) -> tuple[int, dict]:
    action = data.get("action")
    with _LOCK:
        storage, bricks = _read(root)
        if storage == "malformed":
            return 409, {"error": "malformed", "message": MESSAGES["malformed"]}
        if action == "create":
            if len(bricks) >= MAX_BRICKS:
                return _error(409, "full")
            parsed = _parse(data, brick_id="brick-" + os.urandom(8).hex())
            if parsed is None:
                return _error(400, "validation")
            if any(b["name"].casefold() == parsed["name"].casefold() for b in bricks):
                return _error(409, "duplicate")
            bricks.append(parsed)
        elif action in ("update", "delete"):
            brick_id = data.get("id")
            if not isinstance(brick_id, str) or not _ID.fullmatch(brick_id):
                return _error(400, "validation")
            index = next((i for i, b in enumerate(bricks) if b["id"] == brick_id), None)
            if index is None:
                return _error(404, "missing")
            if action == "delete":
                bricks.pop(index)
            else:
                parsed = _parse(data, brick_id=brick_id)
                if parsed is None:
                    return _error(400, "validation")
                if any(b["name"].casefold() == parsed["name"].casefold() and b["id"] != brick_id for b in bricks):
                    return _error(409, "duplicate")
                bricks[index] = parsed
        else:
            return _error(400, "validation")
        _write(root, bricks)
        return 200, _payload(bricks)


def suggested_words(metadata) -> list:
    """Most frequent training tags from a LoRA file's own metadata (ss_tag_frequency), as suggestions."""
    if not isinstance(metadata, dict):
        return []
    raw = metadata.get("ss_tag_frequency")
    if isinstance(raw, str) and len(raw) <= 1_000_000:
        try:
            raw = json.loads(raw)
        except ValueError:
            return []
    if not isinstance(raw, dict):
        return []
    counts: dict = {}
    for group in list(raw.values())[:32]:
        if not isinstance(group, dict):
            continue
        for tag, count in list(group.items())[:5000]:
            if not isinstance(tag, str) or isinstance(count, bool) or not isinstance(count, (int, float)):
                continue
            tag = tag.strip()
            if not tag or len(tag) > MAX_WORD or _WORD_BAD.search(tag):
                continue
            key = tag.casefold()
            seen = counts.get(key)
            counts[key] = (seen[0] if seen else tag, (seen[1] if seen else 0) + float(count))
    ranked = sorted(counts.values(), key=lambda item: (-item[1], item[0].casefold()))
    return [tag for tag, _count in ranked[:MAX_SUGGESTED]]


def local_loras(*, transport=None) -> dict:
    """This PC's LoRAs with suggested trigger words. Read-only, local Forge only."""
    try:
        rows = forge.read_loras(transport=transport)
    except Exception:
        return {"forge": "error", "loras": []}
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        name = row.get("name")
        if not isinstance(name, str) or not name or len(name) > MAX_LORA or _LORA_BAD.search(name):
            continue
        alias = row.get("alias")
        alias = alias if isinstance(alias, str) and 0 < len(alias) <= MAX_LORA and not _CONTROL.search(alias) else name
        out.append({"name": name, "alias": alias, "words": suggested_words(row.get("metadata"))})
        if len(out) >= MAX_LORAS:
            break
    out.sort(key=lambda item: item["name"].casefold())
    return {"forge": "ready", "loras": out}


def serve_get(root: Path, raw: str, *, transport=None) -> tuple[int, dict] | None:
    if raw == "/api/forge/bricks":
        return 200, list_bricks(root)
    if raw == "/api/forge/bricks/loras":
        return 200, local_loras(transport=transport)
    if raw.startswith("/api/forge/bricks/"):
        return 404, {"error": "Inconnu"}
    return None


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw == "/api/forge/bricks":
        if not isinstance(data, dict):
            return _error(400, "validation")
        return _mutate(root, data)
    if raw.startswith("/api/forge/bricks/"):
        return 404, {"error": "Inconnu"}
    return None
