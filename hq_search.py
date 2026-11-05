"""Global search for the Ctrl+K palette: Carnet pages, Forge prompts, calendar events, Inbox file names.

Pure: the bridge passes the rows in. Matching ignores case and accents; every word of the query must
appear (in the title or the text). Titles rank above body text, then the newest first. The private
vault is never a source. Results use the palette's shape: {kind, id, label, hint} (+ 'at' for events,
'dir' for files), bounded per group.
"""

from __future__ import annotations

import functools
import os
import unicodedata
from pathlib import Path

MIN_QUERY = 2
PER_GROUP = 5
SNIPPET = 70
FILES_SCAN_MAX = 5000


def fold(text) -> str:
    """Lower case without accents, for matching only (never shown)."""
    if not isinstance(text, str):
        return ""
    return _fold_str(text) if len(text) <= 512 else _fold_uncached(text)


@functools.lru_cache(maxsize=8192)
def _fold_str(text: str) -> str:  # titles / names / queries repeat across keystrokes and searches
    return _fold_uncached(text)


def _fold_uncached(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).casefold()


def words(query) -> list[str]:
    return [w for w in fold(query).split() if w]


def _score(tokens: list[str], title: str, body: str = "") -> int:
    """0 when a word is missing anywhere; otherwise title hits count most, word starts a little more."""
    t, b = fold(title), fold(body)
    total = 0
    for token in tokens:
        if token in t:
            total += 6 + (2 if (" " + t).find(" " + token) >= 0 else 0)
        elif token in b:
            total += 1
        else:
            return 0
    return total


def snippet(text: str, tokens: list[str], width: int = SNIPPET) -> str:
    """A short window of `text` around the first matching word, on one line."""
    flat = " ".join(str(text or "").split())
    if not flat:
        return ""
    folded = fold(flat)
    at = min((folded.find(t) for t in tokens if folded.find(t) >= 0), default=0)
    # fold() can change lengths for a few characters; clamp so the window always stays in range
    start = max(0, min(len(flat), at) - width // 3)
    piece = flat[start:start + width]
    return ("…" if start > 0 else "") + piece + ("…" if start + width < len(flat) else "")


def _rank(rows: list[tuple[int, float, dict]]) -> list[dict]:
    rows.sort(key=lambda r: (-r[0], -r[1]))
    return [row for _s, _t, row in rows[:PER_GROUP]]


def search_pages(tokens: list[str], pages) -> list[dict]:
    """pages: [{id, title, text, updated_at, deleted_at}]"""
    rows = []
    for page in pages or ():
        if not isinstance(page, dict) or page.get("deleted_at") or not isinstance(page.get("id"), str):
            continue
        title = str(page.get("title") or "Sans titre")
        text = str(page.get("text") or "")
        score = _score(tokens, title, text)
        if score:
            hint = snippet(text, tokens) if not all(t in fold(title) for t in tokens) else ""
            rows.append((score, float(page.get("updated_at") or 0), {
                "kind": "page", "id": page["id"][:120], "label": title[:120], "hint": ("Carnet · " + hint if hint else "Carnet")[:160]}))
    return _rank(rows)


def search_prompts(tokens: list[str], images) -> list[dict]:
    """images: [{id, prompt, created}] from the normal gallery only."""
    rows = []
    for image in images or ():
        if not isinstance(image, dict) or not isinstance(image.get("id"), str):
            continue
        prompt = " ".join(str(image.get("prompt") or "").split())
        score = _score(tokens, prompt)
        if score:
            created = str(image.get("created") or "")  # ISO text: newest sorts last as a string
            rows.append((score, created, {"kind": "prompt", "id": image["id"][:120], "label": prompt[:120],
                                          "hint": ("Forge · " + created[:10]) if created else "Forge"}))
    best = sorted(rows, key=lambda r: (r[0], r[1]), reverse=True)[:PER_GROUP]
    return [row for _s, _c, row in best]


def search_events(tokens: list[str], events) -> list[dict]:
    """events: [{id, title, start, all_day}] (titles only; notes are never searched or shown)."""
    rows = []
    for event in events or ():
        if not isinstance(event, dict) or not isinstance(event.get("id"), str):
            continue
        title = str(event.get("title") or "")
        score = _score(tokens, title)
        if score:
            start = str(event.get("start") or "")
            when = start[:10] + ("" if event.get("all_day") or len(start) < 16 else " · " + start[11:16])
            rows.append((score, 0.0, {"kind": "event", "id": event["id"][:120], "label": title[:120],
                                       "hint": ("Calendrier · " + when) if when else "Calendrier", "at": start[:10]}))
    best = sorted(rows, key=lambda r: (r[0], r[2]["at"]), reverse=True)[:PER_GROUP]
    return [row for _s, _t, row in best]


def search_files(tokens: list[str], files) -> list[dict]:
    """files: [{rel, name, mtime}] (names only; contents are never read)."""
    rows = []
    for item in files or ():
        if not isinstance(item, dict) or not isinstance(item.get("rel"), str):
            continue
        name = str(item.get("name") or "")
        score = _score(tokens, name)
        if score:
            folder = item["rel"].rsplit("/", 1)[0] if "/" in item["rel"] else ""
            rows.append((score, float(item.get("mtime") or 0), {"kind": "file", "id": item["rel"][:240], "label": name[:120],
                                                                  "hint": folder[:160] or "Fichiers", "dir": folder}))
    return _rank(rows)


def inbox_files(root: Path, *, limit: int = FILES_SCAN_MAX) -> list[dict]:
    # Not cached on purpose: directory mtimes are not a reliable change signal (NTFS can lag a create), and a
    # stale listing would hide a just-uploaded file. The scan is bounded by FILES_SCAN_MAX.
    return _inbox_files_scan(root, limit=limit)


def _inbox_files_scan(root: Path, *, limit: int = FILES_SCAN_MAX) -> list[dict]:
    """Names of files in Inbox and its direct subfolders (rel paths from the HQ root). Hidden and
    underscore entries are skipped; links are not followed; at most `limit` entries are looked at."""
    out: list[dict] = []
    seen = 0
    inbox = Path(root) / "Inbox"

    def walk(folder: Path, rel: str, depth: int) -> bool:
        nonlocal seen
        try:
            entries = list(os.scandir(folder))
        except OSError:
            return True
        for entry in entries:
            seen += 1
            if seen > limit:
                return False
            if entry.name.startswith((".", "_")):
                continue
            try:
                if entry.is_dir(follow_symlinks=False):
                    if depth == 0 and not walk(Path(entry.path), rel + "/" + entry.name, 1):
                        return False
                elif entry.is_file(follow_symlinks=False):
                    out.append({"rel": rel + "/" + entry.name, "name": entry.name,
                                "mtime": entry.stat(follow_symlinks=False).st_mtime})
            except OSError:
                continue
        return True

    walk(inbox, "Inbox", 0)
    return out


def search(query, *, pages=(), images=(), events=(), files=()) -> list[dict]:
    tokens = words(query)
    if not tokens or len(" ".join(tokens)) < MIN_QUERY:
        return []
    return (search_pages(tokens, pages) + search_prompts(tokens, images)
            + search_events(tokens, events) + search_files(tokens, files))
