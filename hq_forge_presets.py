"""Named Forge Studio presets.

Presets are administrator UX settings, stored in ``.hq-forge/presets.json``
beside the job index. They are not encrypted images and they are not written
into the private vault. A technical preset stores settings and the negative
prompt, and discards the positive prompt. A creative preset stores both.

A missing file is an empty list. A malformed file is left untouched and
blocks later writes, so an unreadable file is never replaced by accident.

Positive and negative prompts keep their text, including line breaks and
surrounding spaces. Names, models, samplers, and schedulers stay a single
line. NUL and other control characters are rejected. A prompt that exceeds
its limit is rejected whole; it is not trimmed to fit.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path

VERSION = 1
MAX_PRESETS = 40
MAX_NAME = 60
_ID = re.compile(r"^preset-[0-9a-f]{16}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# Tab, LF, and CR are kept in prompts. NUL, the other C0 controls, DEL, and C1 are not.
_UNSAFE_PROMPT = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
_LOCK = threading.Lock()

_MESSAGES = {
    "validation": "Ce préréglage n'est pas accepté.",
    "missing": "Ce préréglage n'existe pas.",
    "duplicate": "Ce nom est déjà utilisé.",
    "full": "La liste de préréglages est pleine.",
    "malformed": "Le fichier de préréglages est illisible. Il n'a pas été remplacé.",
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _path(root: Path) -> Path:
    folder = Path(root) / ".hq-forge"
    folder.mkdir(parents=True, exist_ok=True)
    return folder / "presets.json"


def _new_id() -> str:
    return "preset-" + os.urandom(8).hex()


def _text(value, limit: int, required: bool) -> str | None:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or _CONTROL.search(value):
        return None
    cleaned = value.strip()
    if required and not cleaned:
        return None
    if len(cleaned) > limit:
        return None
    return cleaned


def _prompt(value, limit: int) -> str | None:
    if value is None:
        return ""
    if not isinstance(value, str) or _UNSAFE_PROMPT.search(value):
        return None
    if len(value) > limit:
        return None
    return value


def _int(value, low: int, high: int) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if low <= value <= high:
        return value
    return None


def _number(value, low: float, high: float) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    number = float(value)
    if low <= number <= high:
        return number
    return None


def _settings(data: dict, *, kind: str) -> dict | None:
    if not isinstance(data, dict):
        return None
    forbidden = {"image", "images", "recovery_key", "passphrase", "pin", "thumb", "original", "sha256"}
    if forbidden & set(data):
        return None
    prompt = _prompt(data.get("prompt", ""), 2000)
    negative = _prompt(data.get("negative_prompt", ""), 1000)
    checkpoint = _text(data.get("checkpoint", ""), 180, required=True)
    sampler = _text(data.get("sampler_name", ""), 80, required=True)
    scheduler = _text(data.get("scheduler", ""), 80, required=True)
    width = _int(data.get("width"), 256, 1536)
    height = _int(data.get("height"), 256, 1536)
    steps = _int(data.get("steps"), 1, 40)
    n_iter = _int(data.get("n_iter"), 1, 2)
    seed = _int(data.get("seed"), -1, 2**32 - 1)
    batch = _int(data.get("batch_size", 1), 1, 1)
    cfg = _number(data.get("cfg_scale"), 1, 15)
    if None in (prompt, negative, checkpoint, sampler, scheduler, width, height, steps, n_iter, seed, batch, cfg):
        return None
    if width % 64 or height % 64:
        return None
    include_prompt = kind == "creative"
    return {
        "include_prompt": include_prompt,
        "prompt": prompt if include_prompt else "",
        "negative_prompt": negative,
        "checkpoint": checkpoint,
        "sampler_name": sampler,
        "scheduler": scheduler,
        "width": width,
        "height": height,
        "steps": steps,
        "cfg_scale": cfg,
        "seed": seed,
        "n_iter": n_iter,
        "batch_size": 1,
    }


def _public(item: dict) -> dict:
    stored = dict(item)
    stored.pop("updated", None)
    return stored


def _valid_stored(item) -> dict | None:
    if not isinstance(item, dict):
        return None
    if set(item) - {
        "id", "name", "kind", "include_prompt", "prompt", "negative_prompt", "checkpoint",
        "sampler_name", "scheduler", "width", "height", "steps", "cfg_scale", "seed",
        "n_iter", "batch_size", "updated",
    }:
        return None
    ident = item.get("id")
    name = _text(item.get("name"), MAX_NAME, required=True)
    kind = item.get("kind")
    if not isinstance(ident, str) or not _ID.fullmatch(ident) or name is None or kind not in ("technical", "creative"):
        return None
    settings = _settings(item, kind=kind)
    if settings is None or settings["include_prompt"] != item.get("include_prompt"):
        return None
    if kind == "technical" and item.get("prompt") not in ("", None):
        return None
    return {"id": ident, "name": name, "kind": kind, "updated": item.get("updated") or "", **settings}


def _read(root: Path) -> tuple[str, list[dict]]:
    path = _path(root)
    if not path.is_file():
        return "ready", []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError):
        return "malformed", []
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get("presets"), list):
        return "malformed", []
    if len(data["presets"]) > MAX_PRESETS:
        return "malformed", []
    presets = []
    seen = set()
    names = set()
    for item in data["presets"]:
        parsed = _valid_stored(item)
        if parsed is None or parsed["id"] in seen or parsed["name"].casefold() in names:
            return "malformed", []
        seen.add(parsed["id"])
        names.add(parsed["name"].casefold())
        presets.append(parsed)
    return "ready", presets


def _write(root: Path, presets: list[dict]) -> None:
    path = _path(root)
    temporary = path.with_name("presets.json.partial")
    payload = json.dumps({"version": VERSION, "presets": presets}, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
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


def _payload(presets: list[dict], storage: str = "ready") -> dict:
    return {
        "version": VERSION,
        "storage": storage,
        "presets": [_public(item) for item in presets],
        "message": _MESSAGES["malformed"] if storage == "malformed" else "",
    }


def list_presets(root: Path) -> dict:
    with _LOCK:
        storage, presets = _read(root)
    return _payload(presets, storage)


def _mutate(root: Path, change) -> tuple[int, dict]:
    with _LOCK:
        storage, presets = _read(root)
        if storage == "malformed":
            return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
        result = change(presets)
        if isinstance(result, tuple):
            return result
        _write(root, presets)
        return 200, _payload(presets)


def create_preset(root: Path, data: dict) -> tuple[int, dict]:
    kind = data.get("kind") if isinstance(data, dict) else None
    name = _text(data.get("name") if isinstance(data, dict) else None, MAX_NAME, required=True)
    settings = _settings(data, kind=kind) if kind in ("technical", "creative") else None
    if name is None or settings is None:
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}

    def change(presets: list[dict]):
        if len(presets) >= MAX_PRESETS:
            return 409, {"error": "full", "message": _MESSAGES["full"]}
        if any(item["name"].casefold() == name.casefold() for item in presets):
            return 409, {"error": "duplicate", "message": _MESSAGES["duplicate"]}
        presets.append({"id": _new_id(), "name": name, "kind": kind, "updated": _now(), **settings})
        return None

    return _mutate(root, change)


def update_preset(root: Path, data: dict) -> tuple[int, dict]:
    if not isinstance(data, dict):
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}
    ident = data.get("id")

    def change(presets: list[dict]):
        current = next((item for item in presets if item["id"] == ident), None)
        if current is None:
            return 404, {"error": "missing", "message": _MESSAGES["missing"]}
        settings = _settings(data, kind=current["kind"])
        if settings is None:
            return 400, {"error": "validation", "message": _MESSAGES["validation"]}
        current.update(settings)
        current["updated"] = _now()
        return None

    return _mutate(root, change)


def rename_preset(root: Path, data: dict) -> tuple[int, dict]:
    if not isinstance(data, dict):
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}
    ident = data.get("id")
    name = _text(data.get("name"), MAX_NAME, required=True)
    if name is None:
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}

    def change(presets: list[dict]):
        current = next((item for item in presets if item["id"] == ident), None)
        if current is None:
            return 404, {"error": "missing", "message": _MESSAGES["missing"]}
        if any(item["id"] != ident and item["name"].casefold() == name.casefold() for item in presets):
            return 409, {"error": "duplicate", "message": _MESSAGES["duplicate"]}
        current["name"] = name
        current["updated"] = _now()
        return None

    return _mutate(root, change)


def duplicate_preset(root: Path, data: dict) -> tuple[int, dict]:
    if not isinstance(data, dict):
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}
    ident = data.get("id")

    def change(presets: list[dict]):
        current = next((item for item in presets if item["id"] == ident), None)
        if current is None:
            return 404, {"error": "missing", "message": _MESSAGES["missing"]}
        if len(presets) >= MAX_PRESETS:
            return 409, {"error": "full", "message": _MESSAGES["full"]}
        base = current["name"]
        name = base
        suffix = 2
        taken = {item["name"].casefold() for item in presets}
        while name.casefold() in taken:
            extra = f" {suffix}"
            name = (base[: MAX_NAME - len(extra)] + extra).strip()
            suffix += 1
        copy = dict(current)
        copy["id"] = _new_id()
        copy["name"] = name
        copy["updated"] = _now()
        presets.append(copy)
        return None

    return _mutate(root, change)


def delete_preset(root: Path, data: dict) -> tuple[int, dict]:
    if not isinstance(data, dict):
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}
    ident = data.get("id")

    def change(presets: list[dict]):
        kept = [item for item in presets if item["id"] != ident]
        if len(kept) == len(presets):
            return 404, {"error": "missing", "message": _MESSAGES["missing"]}
        presets[:] = kept
        return None

    return _mutate(root, change)


def import_presets(root: Path, data: dict) -> tuple[int, dict]:
    if not isinstance(data, dict) or data.get("version") not in (None, VERSION) or not isinstance(data.get("presets"), list):
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}
    incoming = []
    for item in data["presets"]:
        if not isinstance(item, dict):
            return 400, {"error": "validation", "message": _MESSAGES["validation"]}
        kind = item.get("kind")
        name = _text(item.get("name"), MAX_NAME, required=True)
        settings = _settings(item, kind=kind) if kind in ("technical", "creative") else None
        if name is None or settings is None:
            return 400, {"error": "validation", "message": _MESSAGES["validation"]}
        incoming.append((name, kind, settings))

    def change(presets: list[dict]):
        if len(presets) + len(incoming) > MAX_PRESETS:
            return 409, {"error": "full", "message": _MESSAGES["full"]}
        taken = {item["name"].casefold() for item in presets}
        staged = []
        for name, kind, settings in incoming:
            if name.casefold() in taken:
                return 409, {"error": "duplicate", "message": _MESSAGES["duplicate"]}
            taken.add(name.casefold())
            staged.append({"id": _new_id(), "name": name, "kind": kind, "updated": _now(), **settings})
        presets.extend(staged)
        return None

    return _mutate(root, change)


def serve_get(root: Path, raw: str) -> tuple[int, dict] | None:
    if raw != "/api/forge/presets":
        return None
    return 200, list_presets(root)


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw != "/api/forge/presets":
        return None
    if not isinstance(data, dict):
        return 400, {"error": "validation", "message": _MESSAGES["validation"]}
    action = data.get("action")
    if action == "create":
        return create_preset(root, data)
    if action == "update":
        return update_preset(root, data)
    if action == "rename":
        return rename_preset(root, data)
    if action == "duplicate":
        return duplicate_preset(root, data)
    if action == "delete":
        return delete_preset(root, data)
    if action == "import":
        return import_presets(root, data)
    return 400, {"error": "validation", "message": _MESSAGES["validation"]}
