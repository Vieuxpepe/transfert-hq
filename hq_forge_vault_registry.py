"""Forge Studio multi-vault registry (plain text, version 1).

The registry only describes vaults so they can be told apart while locked. It has no
cryptographic weight: every vault keeps its own keys in its own folder, a session holds at
most one vault key, and an altered registry can only hide a vault or relabel it, never open
one or mix two. Every field is validated on read; anything unexpected rejects the whole file.

No I/O here: hq_forge_vault reads and writes the file with its reparse-safe helpers.
"""

from __future__ import annotations

import datetime
import json
import os
import re
import unicodedata

VERSION = 1
MAX_VAULTS = 12  # confirmed by Emie; also hq_forge_vault.GLOBAL_MAX_VAULTS
MAX_BYTES = 64 * 1024
LABEL_MAX = 40
ORDER_MAX = 999
VID_RE = re.compile(r"^vlt-[0-9a-f]{16}$")
DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
# Fixed sets. The UI (V4/V5) maps these ids to drawings and contrast-checked colours.
GLYPHS = ("coffre", "etoile", "lune", "soleil", "feuille", "fleur", "vague", "montagne", "nuage", "flamme", "coeur", "cle")
COLOURS = ("ardoise", "bleu", "sarcelle", "vert", "olive", "ambre", "orange", "rouge", "rose", "violet")
DEFAULT_GLYPH = "coffre"
DEFAULT_COLOUR = "ardoise"
MIGRATED_LABEL = "Coffre"
ENTRY_KEYS = ("id", "label", "glyph", "colour", "discret", "order", "created", "last_used_day")
TOP_KEYS = ("version", "legacy", "vaults")


class RegistryError(Exception):
    """Always the single code 'registry': no detail about which field failed is shown."""

    def __init__(self) -> None:
        super().__init__("registry")
        self.code = "registry"


def new_vid() -> str:
    """Random, never derived from the label."""
    return "vlt-" + os.urandom(8).hex()


def today() -> str:
    return datetime.date.today().isoformat()


def clean_label(value) -> str | None:
    """A short visible name, or None when it is not acceptable."""
    if not isinstance(value, str):
        return None
    text = unicodedata.normalize("NFC", value).strip()
    if not text or len(text) > LABEL_MAX:
        return None
    for ch in text:
        if unicodedata.category(ch).startswith("C") or ch in "<>":
            return None
    return text


def _day(value, *, allow_none: bool) -> bool:
    if value is None:
        return allow_none
    if not isinstance(value, str) or not DAY_RE.fullmatch(value):
        return False
    try:
        datetime.date.fromisoformat(value)
    except ValueError:
        return False
    return True


def _order(value) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and 0 <= value <= ORDER_MAX


def validate_entry(entry) -> dict:
    if not isinstance(entry, dict) or set(entry) != set(ENTRY_KEYS):
        raise RegistryError()
    vid = entry["id"]
    if not isinstance(vid, str) or not VID_RE.fullmatch(vid):
        raise RegistryError()
    discret = entry["discret"]
    if not isinstance(discret, bool):
        raise RegistryError()
    label = entry["label"]
    if discret:
        if label is not None:
            raise RegistryError()  # a Discret name never sits in the clear
    elif not isinstance(label, str) or clean_label(label) != label:
        raise RegistryError()
    if entry["glyph"] not in GLYPHS or entry["colour"] not in COLOURS:
        raise RegistryError()
    if not _order(entry["order"]):
        raise RegistryError()
    if not _day(entry["created"], allow_none=False) or not _day(entry["last_used_day"], allow_none=True):
        raise RegistryError()
    return {key: entry[key] for key in ENTRY_KEYS}


def validate(data) -> dict:
    if not isinstance(data, dict) or set(data) != set(TOP_KEYS) or data["version"] != VERSION:
        raise RegistryError()
    vaults = data["vaults"]
    if not isinstance(vaults, list) or len(vaults) > MAX_VAULTS:
        raise RegistryError()
    clean = [validate_entry(entry) for entry in vaults]
    ids = [entry["id"] for entry in clean]
    if len(set(ids)) != len(ids):
        raise RegistryError()
    legacy = data["legacy"]
    if legacy is not None and legacy not in ids:
        raise RegistryError()
    return {"version": VERSION, "legacy": legacy, "vaults": clean}


def parse(raw: bytes) -> dict:
    if not isinstance(raw, (bytes, bytearray)) or len(raw) > MAX_BYTES:
        raise RegistryError()
    try:
        data = json.loads(bytes(raw).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise RegistryError() from None
    return validate(data)


def dump(data: dict) -> bytes:
    clean = validate(data)
    payload = json.dumps(clean, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_BYTES:
        raise RegistryError()
    return payload


def empty() -> dict:
    return {"version": VERSION, "legacy": None, "vaults": []}


def find(data: dict, vid) -> dict | None:
    if not isinstance(vid, str) or not VID_RE.fullmatch(vid):
        return None
    return next((entry for entry in data["vaults"] if entry["id"] == vid), None)


def make_entry(vid: str, *, label, glyph, colour, discret: bool, order: int) -> dict:
    """Raises ValueError on a bad field (the caller maps it to 'validation')."""
    if not VID_RE.fullmatch(vid or ""):
        raise ValueError("vid")
    if not isinstance(discret, bool):
        raise ValueError("discret")
    if glyph not in GLYPHS or colour not in COLOURS or not _order(order):
        raise ValueError("field")
    shown = None
    if not discret:
        shown = clean_label(label)
        if shown is None:
            raise ValueError("label")
    entry = {"id": vid, "label": shown, "glyph": glyph, "colour": colour, "discret": discret,
             "order": order, "created": today(), "last_used_day": None}
    return validate_entry(entry)