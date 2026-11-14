"""Forge Studio: normal-mode sessions, gallery labels and library search.

This module deliberately stores only normal-gallery data. Vault images, private
prompts, masks and vault labels never enter these files. A session is a normal
creative intent: a name, an optional prompt/settings snapshot, reference image
ids, notes, and the normal image ids it produced. The library index adds tags,
one collection, a parent image id and a session id to a normal gallery image.

Both files are small JSON documents written atomically. A malformed file is
preserved and blocks writes, like the presets file.
"""

from __future__ import annotations

import json
import os
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs

import hq_forge_gallery as gallery

VERSION = 1
MAX_SESSIONS = 80
MAX_SESSION_IMAGES = 96
MAX_REFERENCES = 8
MAX_TAGS = 12
MAX_TAG = 32
MAX_COLLECTION = 40
MAX_NAME = 80
MAX_NOTE = 1000
MAX_CONTINUITY = 200
MAX_BULK = 96
CONTINUITY_KEYS = ("character", "setting", "palette", "light", "camera")
PAGE_MAX = 48
_ID = re.compile(r"^seance-[0-9a-f]{16}$")
_BATCH = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_LOCK = threading.Lock()

_MESSAGES = {
    "validation": "Cette demande n'est pas acceptée.",
    "missing": "Cette séance ou cette image n'existe pas.",
    "full": "La liste est pleine.",
    "malformed": "Le fichier est illisible. Il n'a pas été remplacé.",
    "private": "Les séances et la bibliothèque restent en mode normal.",
}


def _now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _folder(root: Path) -> Path:
    path = Path(root) / ".hq-forge"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _sessions_path(root: Path) -> Path:
    return _folder(root) / "seances.json"


def _labels_path(root: Path) -> Path:
    return _folder(root) / "library.json"


def _new_id() -> str:
    return "seance-" + os.urandom(8).hex()


def _text(value, limit: int, required: bool = False) -> str | None:
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
    if not isinstance(value, str) or len(value) > limit:
        return None
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]", value):
        return None
    return value


def _read(path: Path, default_key: str) -> tuple[str, dict]:
    if not path.is_file():
        return "ready", {"version": VERSION, default_key: [] if default_key == "sessions" else {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, UnicodeError):
        return "malformed", {"version": VERSION, default_key: [] if default_key == "sessions" else {}}
    if not isinstance(data, dict) or data.get("version") != VERSION or not isinstance(data.get(default_key), type([] if default_key == "sessions" else {})):
        return "malformed", {"version": VERSION, default_key: [] if default_key == "sessions" else {}}
    return "ready", data


def _write(path: Path, data: dict) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except Exception:
        try:
            temporary.unlink()
        except OSError:
            pass
        raise


def _safe_settings(value) -> dict | None:
    """Normal technical/gallery settings only. Unknown keys are rejected."""
    if value is None:
        return {}
    if not isinstance(value, dict):
        return None
    value = dict(value)
    # H.sweepContext() deliberately drops the batch fields; a session is a single
    # settings snapshot, so restore the two values the gallery record requires.
    value.setdefault("n_iter", 1)
    value.setdefault("batch_size", 1)
    try:
        return gallery._settings(value)
    except gallery.GalleryError:
        return None


def _continuity(value) -> dict | None:
    if value is None:
        return {}
    if not isinstance(value, dict) or any(key not in CONTINUITY_KEYS for key in value):
        return None
    out = {}
    for key in CONTINUITY_KEYS:
        text = _text(value.get(key), MAX_CONTINUITY)
        if text is None:
            return None
        out[key] = text
    return out


def _image_ids(value, limit: int) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > limit:
        return None
    out = []
    for item in value:
        if not isinstance(item, str) or not gallery.IMG_RE.fullmatch(item):
            return None
        if item not in out:
            out.append(item)
    return out


def _existing_image(root: Path, image_id: str) -> dict | None:
    try:
        return gallery.get(root, image_id)
    except gallery.GalleryError:
        return None


def _public_session(item: dict, root: Path, full: bool = False) -> dict:
    images = []
    for image_id in item.get("image_ids", []):
        try:
            image = gallery.get(root, image_id)
        except gallery.GalleryError:
            continue
        images.append({"id": image["id"], "thumb": image["thumb"], "created": image.get("created"),
                       "width": image.get("width"), "height": image.get("height"), "triage": image.get("triage")})
    out = {
        "id": item["id"],
        "name": item["name"],
        "created": item["created"],
        "updated": item["updated"],
        "archived": bool(item.get("archived")),
        "image_count": len(images),
        "batch_ids": list(item.get("batch_ids", [])),
        "job_ids": list(item.get("job_ids", [])),
    }
    if full:
        out.update({
            "prompt": item.get("prompt", ""),
            "negative_prompt": item.get("negative_prompt", ""),
            "note": item.get("note", ""),
            "settings": item.get("settings") or {},
            "continuity": dict(item.get("continuity")) if isinstance(item.get("continuity"), dict) else {},
            "reference_ids": list(item.get("reference_ids", [])),
            "images": images,
            "missing_images": max(0, len(item.get("image_ids", [])) - len(images)),
        })
    else:
        out["prompt"] = (item.get("prompt") or "")[:160]
    return out


def _find_session(data: dict, ident: str) -> dict | None:
    return next((item for item in data["sessions"] if isinstance(item, dict) and item.get("id") == ident), None)


def create_session(root: Path, data: dict) -> tuple[int, dict]:
    name = _text(data.get("name"), MAX_NAME, required=True)
    prompt = _prompt(data.get("prompt"), 2000)
    negative = _prompt(data.get("negative_prompt"), 1000)
    note = _text(data.get("note"), MAX_NOTE)
    settings = _safe_settings(data.get("settings")) if data.get("settings") is not None else {}
    continuity = _continuity(data.get("continuity"))
    references = _image_ids(data.get("reference_ids"), MAX_REFERENCES)
    if None in (name, prompt, negative, note, settings, continuity, references):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    for image_id in references:
        if _existing_image(root, image_id) is None:
            return 404, {"error": _MESSAGES["missing"], "code": "missing"}
    with _LOCK:
        storage, store = _read(_sessions_path(root), "sessions")
        if storage == "malformed":
            return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
        if len(store["sessions"]) >= MAX_SESSIONS:
            return 409, {"error": "full", "message": _MESSAGES["full"]}
        now = _now()
        item = {
            "id": _new_id(),
            "name": name,
            "prompt": prompt,
            "negative_prompt": negative,
            "note": note,
            "settings": settings,
            "continuity": continuity,
            "reference_ids": references,
            "image_ids": [],
            "batch_ids": [],
            "job_ids": [],
            "archived": False,
            "created": now,
            "updated": now,
        }
        store["sessions"].append(item)
        _write(_sessions_path(root), store)
    return 200, {"session": _public_session(item, root, True)}


def update_session(root: Path, data: dict) -> tuple[int, dict]:
    ident = data.get("id")
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        storage, store = _read(_sessions_path(root), "sessions")
        if storage == "malformed":
            return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
        item = _find_session(store, ident)
        if item is None:
            return 404, {"error": _MESSAGES["missing"], "code": "missing"}
        if "name" in data:
            name = _text(data.get("name"), MAX_NAME, required=True)
            if name is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["name"] = name
        if "note" in data:
            note = _text(data.get("note"), MAX_NOTE)
            if note is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["note"] = note
        if "prompt" in data:
            prompt = _prompt(data.get("prompt"), 2000)
            if prompt is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["prompt"] = prompt
        if "negative_prompt" in data:
            negative = _prompt(data.get("negative_prompt"), 1000)
            if negative is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["negative_prompt"] = negative
        if "settings" in data:
            settings = _safe_settings(data.get("settings"))
            if settings is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["settings"] = settings
        if "continuity" in data:
            continuity = _continuity(data.get("continuity"))
            if continuity is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["continuity"] = continuity
        if "reference_ids" in data:
            references = _image_ids(data.get("reference_ids"), MAX_REFERENCES)
            if references is None:
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            for image_id in references:
                if _existing_image(root, image_id) is None:
                    return 404, {"error": _MESSAGES["missing"], "code": "missing"}
            item["reference_ids"] = references
        if "archived" in data:
            if not isinstance(data.get("archived"), bool):
                return 400, {"error": _MESSAGES["validation"], "code": "validation"}
            item["archived"] = data["archived"]
        item["updated"] = _now()
        _write(_sessions_path(root), store)
    return 200, {"session": _public_session(item, root, True)}


def attach(root: Path, data: dict) -> tuple[int, dict]:
    ident = data.get("id")
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    new_images = _image_ids(data.get("image_ids"), MAX_SESSION_IMAGES)
    batch_id = data.get("batch_id")
    job_id = data.get("job_id")
    if new_images is None or (batch_id is not None and (not isinstance(batch_id, str) or not _BATCH.fullmatch(batch_id))):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    if job_id is not None and (not isinstance(job_id, str) or not _BATCH.fullmatch(job_id)):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    for image_id in new_images:
        if _existing_image(root, image_id) is None:
            return 404, {"error": _MESSAGES["missing"], "code": "missing"}
    with _LOCK:
        storage, store = _read(_sessions_path(root), "sessions")
        if storage == "malformed":
            return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
        item = _find_session(store, ident)
        if item is None:
            return 404, {"error": _MESSAGES["missing"], "code": "missing"}
        images = item.setdefault("image_ids", [])
        for image_id in new_images:
            if image_id not in images:
                images.append(image_id)
        if len(images) > MAX_SESSION_IMAGES:
            return 409, {"error": "full", "message": _MESSAGES["full"]}
        if batch_id and batch_id not in item.setdefault("batch_ids", []):
            item["batch_ids"].append(batch_id)
        if job_id and job_id not in item.setdefault("job_ids", []):
            item["job_ids"].append(job_id)
        item["updated"] = _now()
        _write(_sessions_path(root), store)
        # The library's session filter reads this label rather than rewriting images.
        labels_storage, labels = _read(_labels_path(root), "labels")
        if labels_storage == "ready":
            for image_id in new_images:
                record = labels["labels"].setdefault(image_id, {})
                record["session"] = ident
            _write(_labels_path(root), labels)
    return 200, {"session": _public_session(item, root, True)}


def delete_session(root: Path, data: dict) -> tuple[int, dict]:
    ident = data.get("id")
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        storage, store = _read(_sessions_path(root), "sessions")
        if storage == "malformed":
            return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
        before = len(store["sessions"])
        store["sessions"] = [item for item in store["sessions"] if item.get("id") != ident]
        if len(store["sessions"]) == before:
            return 404, {"error": _MESSAGES["missing"], "code": "missing"}
        _write(_sessions_path(root), store)
    return 200, {"deleted": ident}


def list_sessions(root: Path, include_archived: bool = False) -> tuple[int, dict]:
    storage, store = _read(_sessions_path(root), "sessions")
    if storage == "malformed":
        return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
    sessions = [item for item in store["sessions"] if include_archived or not item.get("archived")]
    sessions.sort(key=lambda item: (str(item.get("updated") or ""), str(item.get("id") or "")), reverse=True)
    return 200, {"sessions": [_public_session(item, root) for item in sessions]}


def get_session(root: Path, ident: str) -> tuple[int, dict]:
    if not isinstance(ident, str) or not _ID.fullmatch(ident):
        return 404, {"error": _MESSAGES["missing"], "code": "missing"}
    storage, store = _read(_sessions_path(root), "sessions")
    if storage == "malformed":
        return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
    item = _find_session(store, ident)
    if item is None:
        return 404, {"error": _MESSAGES["missing"], "code": "missing"}
    return 200, {"session": _public_session(item, root, True)}


def _labels(root: Path) -> dict:
    storage, data = _read(_labels_path(root), "labels")
    if storage == "malformed":
        return {}
    return data["labels"]


def _tag_list(value) -> list[str] | None:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_TAGS:
        return None
    out = []
    seen = set()
    for item in value:
        if not isinstance(item, str) or _CONTROL.search(item):
            return None
        tag = item.strip()
        if not tag or len(tag) > MAX_TAG:
            return None
        key = tag.casefold()
        if key in seen:
            continue
        seen.add(key)
        out.append(tag)
    return out


def set_labels(root: Path, data: dict) -> tuple[int, dict]:
    image_id = data.get("id")
    if not isinstance(image_id, str) or not gallery.IMG_RE.fullmatch(image_id) or _existing_image(root, image_id) is None:
        return 404, {"error": _MESSAGES["missing"], "code": "missing"}
    tags = _tag_list(data.get("tags")) if "tags" in data else None
    collection = _text(data.get("collection"), MAX_COLLECTION) if "collection" in data else None
    parent = data.get("parent") if "parent" in data else None
    session = data.get("session") if "session" in data else None
    if ("tags" in data and tags is None) or ("collection" in data and collection is None) or ("parent" in data and parent not in ("", None) and (not isinstance(parent, str) or not gallery.IMG_RE.fullmatch(parent))) or ("session" in data and session not in ("", None) and (not isinstance(session, str) or not _ID.fullmatch(session))):
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    with _LOCK:
        storage, store = _read(_labels_path(root), "labels")
        if storage == "malformed":
            return 409, {"error": "malformed", "message": _MESSAGES["malformed"]}
        record = store["labels"].setdefault(image_id, {})
        if tags is not None:
            record["tags"] = tags
        if collection is not None:
            record["collection"] = collection
        if parent is not None:
            record["parent"] = parent or ""
        if session is not None:
            record["session"] = session or ""
        if "parent" in data and parent and _existing_image(root, parent) is None:
            # The image's parent must still exist; a stale parent is refused.
            return 404, {"error": _MESSAGES["missing"], "code": "missing"}
        if not record.get("tags") and not record.get("collection") and not record.get("session") and not record.get("parent"):
            store["labels"].pop(image_id, None)
        _write(_labels_path(root), store)
    return 200, {"image": image_id, "labels": record}


def bulk_triage(root: Path, data: dict) -> tuple[int, dict]:
    ids = _image_ids(data.get("ids"), MAX_BULK)
    state = data.get("state")
    if ids is None or not ids or state not in gallery.TRIAGE:
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    changed = []
    for image_id in ids:
        try:
            changed.append(gallery.set_triage(root, image_id, state))
        except gallery.GalleryError:
            continue
    return 200, {"changed": changed, "count": len(changed)}


def _row(root: Path, image_id: str, labels: dict) -> dict | None:
    try:
        data = gallery._meta(root, image_id)
    except gallery.GalleryError:
        return None
    settings = data.get("settings") if isinstance(data.get("settings"), dict) else {}
    label = labels.get(image_id) if isinstance(labels.get(image_id), dict) else {}
    origin = data.get("origin") if isinstance(data.get("origin"), dict) else None
    return {
        "id": image_id,
        "created": data.get("created"),
        "width": data.get("width"),
        "height": data.get("height"),
        "triage": gallery.triage_of(data),
        "thumb": f"/api/forge/gallery/{image_id}/thumb",
        "settings": {key: settings.get(key) for key in gallery.HISTORY_FIELDS if settings.get(key) is not None},
        "labels": {"tags": list(label.get("tags") or []), "collection": label.get("collection") or "",
                    "session": label.get("session") or "", "parent": label.get("parent") or ""},
        "origin": origin,
        "batch_id": (origin or {}).get("batch_id") or "",
        "device": (origin or {}).get("worker_name") or ("Cet HQ" if not origin or not origin.get("worker_id") else ""),
    }


def library_page(root: Path, query: dict) -> dict:
    labels = _labels(root)
    rows = []
    base = gallery.gallery_dir(root)
    if base.is_dir() and not base.is_symlink():
        for child in base.iterdir():
            if child.is_symlink() or not gallery.IMG_RE.fullmatch(child.name):
                continue
            row = _row(root, child.name, labels)
            if row is not None:
                rows.append(row)
    view = (query.get("view") or [""])[0]
    rows = [row for row in rows if (row["triage"] == "reject") == (view == "trash")]
    if view == "untriaged":
        rows = [row for row in rows if row["triage"] == "none"]
    needle = (query.get("q") or [""])[0].strip().casefold()[:200]
    tag = (query.get("tag") or [""])[0].strip().casefold()
    collection = (query.get("collection") or [""])[0].strip().casefold()
    session = (query.get("session") or [""])[0].strip()
    model = (query.get("model") or [""])[0].strip().casefold()
    sampler = (query.get("sampler") or [""])[0].strip().casefold()
    steps = (query.get("steps") or [""])[0].strip()
    cfg = (query.get("cfg") or [""])[0].strip()
    lora = (query.get("lora") or [""])[0].strip().casefold()
    seed = (query.get("seed") or [""])[0].strip()
    width = (query.get("width") or [""])[0].strip()
    height = (query.get("height") or [""])[0].strip()
    date_from = (query.get("from") or [""])[0].strip()
    date_to = (query.get("to") or [""])[0].strip()
    if needle:
        def hit(row):
            settings = row["settings"]
            parts = [settings.get("prompt"), settings.get("negative_prompt"), settings.get("checkpoint"),
                     settings.get("sampler_name"), settings.get("scheduler"), row["labels"]["collection"],
                     row["device"], " ".join(row["labels"]["tags"])]
            return any(needle in str(part or "").casefold() for part in parts)
        rows = [row for row in rows if hit(row)]
    if tag:
        rows = [row for row in rows if any(tag == item.casefold() for item in row["labels"]["tags"])]
    if collection:
        rows = [row for row in rows if collection == row["labels"]["collection"].casefold()]
    if session:
        rows = [row for row in rows if session == row["labels"]["session"]]
    if model:
        rows = [row for row in rows if model in str(row["settings"].get("checkpoint") or "").casefold()]
    if sampler:
        rows = [row for row in rows if sampler in str(row["settings"].get("sampler_name") or "").casefold()]
    if steps:
        rows = [row for row in rows if steps == str(row["settings"].get("steps"))]
    if cfg:
        rows = [row for row in rows if cfg == str(row["settings"].get("cfg_scale"))]
    if lora:
        def lora_hit(row):
            prompt = str(row["settings"].get("prompt") or "")
            return lora in prompt.casefold() and "<lora:" in prompt.casefold()
        rows = [row for row in rows if lora_hit(row)]
    if seed:
        rows = [row for row in rows if seed == str(row["settings"].get("seed"))]
    if width:
        rows = [row for row in rows if width == str(row["width"])]
    if height:
        rows = [row for row in rows if height == str(row["height"])]
    if date_from:
        rows = [row for row in rows if str(row["created"] or "") >= date_from]
    if date_to:
        rows = [row for row in rows if str(row["created"] or "") <= date_to + "~"]
    rows.sort(key=lambda row: (str(row.get("created") or ""), row["id"]), reverse=True)
    total = len(rows)
    try:
        offset = max(0, int((query.get("offset") or ["0"])[0]))
    except ValueError:
        offset = 0
    limit = PAGE_MAX
    try:
        limit = max(1, min(PAGE_MAX, int((query.get("limit") or [str(PAGE_MAX)])[0])))
    except ValueError:
        pass
    return {"images": rows[offset:offset + limit], "total": total, "offset": offset,
            "next_offset": offset + limit if offset + limit < total else None}


def family(root: Path, image_id: str) -> tuple[int, dict]:
    if not isinstance(image_id, str) or not gallery.IMG_RE.fullmatch(image_id):
        return 404, {"error": _MESSAGES["missing"], "code": "missing"}
    labels = _labels(root)
    nodes = []
    current = image_id
    seen = set()
    relation = "image"
    while current and current not in seen and len(seen) < 20:
        seen.add(current)
        row = _row(root, current, labels)
        if row is None:
            break
        nodes.append({"id": current, "relation": relation, "created": row["created"], "thumb": row["thumb"],
                      "triage": row["triage"]})
        origin = row.get("origin") or {}
        parent = row["labels"]["parent"] or origin.get("finish_of") or origin.get("inpaint_of") or origin.get("outpaint_of") or ""
        relation = "finition" if origin.get("finish_of") else ("retouche" if origin.get("inpaint_of") else ("extension" if origin.get("outpaint_of") else "branche"))
        current = parent if isinstance(parent, str) else ""
    children = []
    if image_id in seen:
        for child_id, record in labels.items():
            if isinstance(record, dict) and record.get("parent") == image_id and child_id not in seen:
                child = _row(root, child_id, labels)
                if child:
                    children.append({"id": child_id, "relation": "branche", "created": child["created"],
                                     "thumb": child["thumb"], "triage": child["triage"]})
    nodes.reverse()
    return 200, {"id": image_id, "nodes": nodes + children[:50]}


def serve_get(root: Path, raw: str, parsed) -> tuple[int, dict] | None:
    if raw == "/api/forge/library":
        return 200, library_page(root, parse_qs(parsed.query))
    if raw == "/api/forge/library/family":
        qs = parse_qs(parsed.query)
        return family(root, (qs.get("id") or [""])[0])
    if raw == "/api/forge/seances":
        qs = parse_qs(parsed.query)
        return list_sessions(root, (qs.get("archived") or [""])[0] == "1")
    prefix = "/api/forge/seances/"
    if raw.startswith(prefix) and "/" not in raw[len(prefix):]:
        return get_session(root, raw[len(prefix):])
    return None


def serve_post(root: Path, raw: str, data: dict) -> tuple[int, dict] | None:
    if raw == "/api/forge/seances":
        action = data.get("action")
        if action == "create":
            return create_session(root, data)
        if action == "update":
            return update_session(root, data)
        if action == "attach":
            return attach(root, data)
        if action == "delete":
            return delete_session(root, data)
        return 400, {"error": _MESSAGES["validation"], "code": "validation"}
    if raw == "/api/forge/library/labels":
        return set_labels(root, data)
    if raw == "/api/forge/library/bulk":
        return bulk_triage(root, data)
    return None
