"""Export a Transfert HQ Else digest for Gemini-Test boot ingest.

Writes evidence bullets only — never merges memory stores, never copies
Transferania's private thread as Else biography, never writes relational scores.
Never writes into the Transfert tree as if it were Gemini-Test.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

HANDOFF_JSON = "ELSE_TRANSFERT_HANDOFF.json"
HANDOFF_MD = "ELSE_TRANSFERT_HANDOFF.md"
DEFAULT_GEMINI = Path(r"C:\Gemini-Test")
MAX_EXCHANGES = 8
MAX_BULLETS = 12
MAX_LINE = 220
_TEST_DEVICE_RE = re.compile(r"^device-else-chip", re.I)


def _utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _clip(text: Any, n: int = MAX_LINE) -> str:
    return re.sub(r"\s+", " ", str(text or "").strip())[:n]


def _gemini_root(explicit: Any = None) -> Path:
    raw = str(explicit or "").strip()
    if raw:
        return Path(raw)
    env = str(os.environ.get("ELSE_GEMINI_ROOT") or "").strip()
    return Path(env) if env else DEFAULT_GEMINI


def _is_safe_gemini_root(root: Path, *, explicit: bool) -> bool:
    """Refuse dumping handoff into HQ; allow Gemini-Test or explicit test dirs."""
    try:
        r = root.resolve()
    except OSError:
        return False
    # Never treat an HQ checkout (or its store root) as the Gemini destination.
    if (r / "iphone_bridge.py").is_file():
        return False
    try:
        import hq_ai as ai
        hq = Path(str(ai._cb.get("root") or "")).resolve()
        if hq and r == hq:
            return False
    except Exception:
        pass
    if r == DEFAULT_GEMINI.resolve():
        return True
    if (r / "else_agent_boot.py").is_file():
        return True
    if not explicit:
        return False
    path = str(r).lower().replace("/", "\\")
    return any(tok in path for tok in ("\\temp\\", "\\tmp\\", "pytest", "gemini-out", "hq-else-", "xfer-"))


def _pick_device_id(ai: Any, device_id: Any = None) -> str | None:
    if device_id:
        did = ai.normalize_device_id(device_id)
        return did
    root = Path(ai._cb["root"]) / ".hq-ai" / ai.ELSE_THREADS
    if not root.is_dir():
        return None
    newest = None
    best_mtime = -1.0
    for p in root.glob("*.json"):
        stem = p.stem
        if _TEST_DEVICE_RE.match(stem):
            continue
        try:
            m = p.stat().st_mtime
        except OSError:
            continue
        if m > best_mtime:
            best_mtime = m
            newest = stem
    return ai.normalize_device_id(newest) if newest else None


def build_digest(*, device_id: Any = None, owner: str = "admin") -> dict:
    import hq_ai as ai
    import hq_companion_memory as mem
    import hq_sister as sister

    did = _pick_device_id(ai, device_id)
    summary = ""
    recent: list[dict] = []
    memories: list[str] = []
    episodes: list[str] = []
    sister_lines: list[str] = []
    open_thread = ""
    views: list[str] = []
    last_view = ""
    meter: dict = {}

    if did:
        token = mem._owner.set(str(owner or "admin"))
        try:
            with mem.memory_scope("else"):
                thread = ai.load_else(did)
                if thread.get("_unreadable"):
                    raise ai.AiError(ai.THREAD_UNREADABLE_MSG, 409, "thread_unreadable")
                snap = mem.snapshot()
                summary = _clip(thread.get("summary") or "", 600)
                msgs = [m for m in (thread.get("messages") or []) if isinstance(m, dict)]
                for m in msgs[-MAX_EXCHANGES * 2 :]:
                    role = str(m.get("role") or "")
                    text = _clip(m.get("text") or "")
                    view = re.sub(r"[^a-z0-9_-]", "", str(m.get("view") or "").lower())[:32]
                    if view:
                        views.append(view)
                        last_view = view
                    if role not in ("user", "assistant") or not text:
                        continue
                    row = {"role": role, "text": text, "ts": m.get("ts")}
                    if view:
                        row["view"] = view
                    recent.append(row)
                memories = [_clip(m.get("text")) for m in (snap.get("memories") or [])[:6] if m.get("text")]
                episodes = [_clip(e.get("text")) for e in (snap.get("episodes") or [])[-6:] if e.get("text")]
        finally:
            mem._owner.reset(token)

        dialogue = sister.load_dialogue(did)
        for m in (dialogue.get("messages") or [])[-6:]:
            if not isinstance(m, dict) or m.get("speaker") not in ("else", "transferania"):
                continue
            label = "Else" if m.get("speaker") == "else" else "Transferania"
            text = _clip(m.get("text"))
            if text:
                sister_lines.append(f"{label}: {text}")
        open_thread = _clip(dialogue.get("open_thread") or "", 200)
        try:
            meter = sister._master_favor_meter(did)
        except Exception:
            meter = {}

    # Distinct recent views (order preserved, newest last).
    view_trail: list[str] = []
    for v in views[-12:]:
        if not view_trail or view_trail[-1] != v:
            view_trail.append(v)
    view_trail = view_trail[-5:]

    bullets: list[str] = []
    if summary:
        bullets.append(f"On Transfert HQ, Else's chat summary: {summary}")
    if last_view:
        bullets.append(f"On Transfert HQ, Else's last page view: {last_view}")
    if view_trail:
        bullets.append("On Transfert HQ, Else recent views: " + " → ".join(view_trail))
    for m in recent[-6:]:
        who = "Master" if m["role"] == "user" else "Else"
        view_bit = f" [{m['view']}]" if m.get("view") else ""
        bullets.append(f"On Transfert HQ ({who}{view_bit}): {m['text']}")
    for text in memories[:4]:
        bullets.append(f"On Transfert HQ (Else memory): {text}")
    for text in episodes[-3:]:
        bullets.append(f"On Transfert HQ (Else episode): {text}")
    if sister_lines:
        bullets.append("On Transfert HQ sister log: " + " | ".join(sister_lines[-4:]))
    if open_thread:
        bullets.append(f"On Transfert HQ open sister thread: {open_thread}")
    if meter.get("tease"):
        bullets.append(f"On Transfert HQ sister attention tease: {meter.get('tease')}")
    empty = not did or (not summary and not recent and not memories and not sister_lines)
    bullets = bullets[:MAX_BULLETS]

    body = {
        "v": 1,
        "source": "transfert_hq",
        "utc": _utc(),
        "device_id": did or "",
        "empty": empty,
        "summary": summary,
        "recent_exchanges": recent,
        "memories": memories,
        "episodes": episodes,
        "sister_lines": sister_lines,
        "open_thread": open_thread,
        "last_view": last_view,
        "view_trail": view_trail,
        "meter": meter,
        "bullets": bullets,
        "note": "Evidence digest for Gemini-Test boot. Not a merged memory store. Do not invent beyond these lines.",
    }
    raw = json.dumps(
        {
            "summary": summary,
            "bullets": bullets,
            "recent": recent,
            "sister": sister_lines,
            "views": view_trail,
            "open_thread": open_thread,
        },
        ensure_ascii=False,
        sort_keys=True,
    )
    body["content_hash"] = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]
    return body


def render_markdown(digest: dict) -> str:
    lines = [
        "# ELSE ← TRANSFERT HQ HANDOFF",
        f"_Generated: {digest.get('utc')} | device={digest.get('device_id')} | hash={digest.get('content_hash')}_",
        "",
        "Evidence from Transfert HQ only. Same Else; do not re-introduce. Do not invent beyond these bullets.",
        "",
        "## Summary",
        digest.get("summary") or "(none)",
        "",
        "## Bullets for ingest",
    ]
    if digest.get("empty") or not digest.get("bullets"):
        lines.append("- (empty — awaiting first Else chip chat on HQ)")
    else:
        for b in digest.get("bullets") or []:
            lines.append(f"- {b}")
    lines.extend(["", "## Sister log"])
    for s in digest.get("sister_lines") or []:
        lines.append(f"- {s}")
    if not digest.get("sister_lines"):
        lines.append("- (none)")
    lines.append("")
    return "\n".join(lines)


def write_digest(digest: dict, *, gemini_root: Any = None) -> dict:
    explicit = gemini_root is not None and str(gemini_root).strip() != ""
    root = _gemini_root(gemini_root)
    if not _is_safe_gemini_root(root, explicit=explicit):
        raise ValueError(
            f"Refusing to write Else handoff outside Gemini-Test (got {root}). "
            "Set ELSE_GEMINI_ROOT or pass a Gemini-Test checkout."
        )
    root.mkdir(parents=True, exist_ok=True)
    json_path = root / HANDOFF_JSON
    md_path = root / HANDOFF_MD
    payload = dict(digest)
    payload["markdown"] = render_markdown(digest)
    json_path.write_text(
        json.dumps({k: v for k, v in payload.items() if k != "markdown"}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    md_path.write_text(payload["markdown"], encoding="utf-8")
    return {
        "ok": True,
        "path": str(json_path),
        "markdown_path": str(md_path),
        "content_hash": digest.get("content_hash"),
        "bullets": len(digest.get("bullets") or []),
        "empty": bool(digest.get("empty")),
        "device_id": digest.get("device_id"),
        "utc": digest.get("utc"),
    }


def export_else_handoff(
    *,
    device_id: Any = None,
    owner: str = "admin",
    gemini_root: Any = None,
    dry_run: bool = False,
) -> dict:
    digest = build_digest(device_id=device_id, owner=owner)
    slim = {k: digest[k] for k in ("v", "source", "utc", "device_id", "content_hash", "summary", "bullets", "empty") if k in digest}
    if dry_run:
        return {
            "ok": True,
            "dry_run": True,
            "wrote": False,
            "content_hash": digest.get("content_hash"),
            "bullets": len(digest.get("bullets") or []),
            "empty": bool(digest.get("empty")),
            "device_id": digest.get("device_id"),
            "utc": digest.get("utc"),
            "digest": slim,
        }
    out = write_digest(digest, gemini_root=gemini_root)
    out["dry_run"] = False
    out["wrote"] = True
    out["digest"] = slim
    return out


def _export_allowed(ai: Any) -> bool:
    """Skip Gemini writes from unit-test temp roots unless ELSE_HANDOFF_EXPORT=1."""
    flag = str(os.environ.get("ELSE_HANDOFF_EXPORT") or "").strip().lower()
    if flag in ("0", "false", "no", "off"):
        return False
    if flag in ("1", "true", "yes", "on"):
        return True
    try:
        root = Path(str(ai._cb.get("root") or ".")).resolve()
    except Exception:
        return False
    path = str(root).lower().replace("/", "\\")
    if any(tok in path for tok in ("\\temp\\", "\\tmp\\", "pytest", "hq-else-")):
        return False
    if root == Path(r"C:\Transfert").resolve():
        return True
    return (root / "iphone_bridge.py").is_file() and (root / ".hq-ai").is_dir()


def maybe_export_after_chat(*, device_id: Any = None, owner: str = "admin") -> dict | None:
    """Best-effort refresh after an Else chat turn — never raises into the chat path."""
    try:
        import hq_ai as ai
        if not _export_allowed(ai):
            return None
        return export_else_handoff(device_id=device_id, owner=owner)
    except Exception:
        return None
