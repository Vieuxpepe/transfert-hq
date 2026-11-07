"""Owner-scoped semantic and episodic archive for Transferania (SQLite + hybrid lexical/n-gram cosine recall)."""
from __future__ import annotations

import hashlib
import json
import math
import re
import sqlite3
import threading
import time
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

import hq_companion_memory as companion_memory

_lock = threading.RLock()


def _db_path() -> Path:
    root = Path(getattr(companion_memory, "_root", "."))
    owner = companion_memory.current_owner()
    key = hashlib.sha256(owner.encode("utf-8")).hexdigest()[:32]
    p = root / ".hq-ai" / "companion-archive" / f"{key}.sqlite"
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def _fold(text: str) -> str:
    s = "".join(c for c in unicodedata.normalize("NFKD", str(text or "").lower()) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", s.replace("’", "'")).strip()


def _embed_features(text: str) -> dict[str, float]:
    """Deterministic hybrid bag-of-stems + character 3/4-gram TF vector (L2-normalized, zero external API calls)."""
    folded = _fold(text)
    if not folded:
        return {}
    counts: Counter[str] = Counter()
    # 1. Word stems (high weight)
    for tok in companion_memory.terms(folded):
        if len(tok) >= 3:
            counts["w:" + tok] += 2.5
    # 2. Character 3-grams and 4-grams inside words (captures roots, typos, and morphological relatives)
    for word in re.findall(r"[a-z0-9]{4,}", folded):
        padded = f"^{word}$"
        for n in (3, 4):
            for i in range(max(0, len(padded) - n + 1)):
                counts["g:" + padded[i:i + n]] += 1.0
    if not counts:
        return {}
    norm = math.sqrt(sum(v * v for v in counts.values())) or 1.0
    # Keep top 80 features to bound storage
    top = sorted(counts.items(), key=lambda kv: -kv[1])[:80]
    return {k: round(v / norm, 4) for k, v in top}


def _cosine(vec_a: dict[str, float], vec_b: dict[str, float]) -> float:
    if not vec_a or not vec_b:
        return 0.0
    if len(vec_a) > len(vec_b):
        vec_a, vec_b = vec_b, vec_a
    return sum(val * vec_b.get(k, 0.0) for k, val in vec_a.items())


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()), timeout=5.0)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS exchanges (
            id TEXT PRIMARY KEY,
            device_id TEXT,
            ts REAL,
            view TEXT,
            user_text TEXT,
            assistant_text TEXT,
            nsfw INTEGER DEFAULT 0,
            vec_json TEXT
        )"""
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_exchanges_ts ON exchanges(ts DESC)")
    return conn


def archive_exchanges(chunk: list[dict], device_id: str = "") -> int:
    """Persist complete (user, assistant) pairs from a compressed chunk into the owner's SQLite archive."""
    if not chunk:
        return 0
    pairs: list[tuple[dict, dict]] = []
    pending_user: dict | None = None
    for m in chunk:
        if not isinstance(m, dict):
            continue
        if str(m.get("kind") or "").lower() in ("ambient", "fallback", "nudge"):
            continue
        if m.get("role") == "user":
            pending_user = m
        elif m.get("role") == "assistant" and pending_user is not None:
            pairs.append((pending_user, m))
            pending_user = None
    if not pairs:
        return 0
    inserted = 0
    with _lock:
        conn = None
        try:
            conn = _connect()
            for u_msg, a_msg in pairs:
                u_txt = str(u_msg.get("text") or "").strip()[:600]
                a_txt = str(a_msg.get("text") or "").strip()[:600]
                if not u_txt or not a_txt:
                    continue
                ts = float(u_msg.get("ts") or a_msg.get("ts") or time.time())
                nsfw = 1 if (u_msg.get("nsfw") or a_msg.get("nsfw")) else 0
                view = str(u_msg.get("view") or a_msg.get("view") or "accueil")[:32]
                uid = hashlib.sha256(f"{round(ts, 1)}|{u_txt[:120]}|{a_txt[:120]}".encode("utf-8")).hexdigest()[:24]
                vec = _embed_features(u_txt + " " + a_txt)
                cur = conn.execute(
                    """INSERT OR IGNORE INTO exchanges
                       (id, device_id, ts, view, user_text, assistant_text, nsfw, vec_json)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (uid, str(device_id or "")[:48], ts, view, u_txt, a_txt, nsfw, json.dumps(vec, ensure_ascii=False)),
                )
                inserted += max(0, cur.rowcount or 0)
            conn.commit()
        except sqlite3.Error:
            return 0
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    return inserted


def search_archive(query: str, *, nsfw: bool = False, limit: int = 2, exclude_texts: set[str] | None = None) -> list[dict[str, Any]]:
    """Return up to ``limit`` semantically relevant past exchanges from the owner's SQLite archive."""
    q_clean = str(query or "").strip()
    if len(q_clean) < 4:
        return []
    q_vec = _embed_features(q_clean)
    q_terms = companion_memory.terms(q_clean)
    if not q_vec or not q_terms:
        return []
    excluded = {_fold(x) for x in (exclude_texts or set()) if x}
    scored: list[tuple[float, dict[str, Any]]] = []
    with _lock:
        conn = None
        try:
            if not _db_path().exists():
                return []
            conn = _connect()
            rows = conn.execute(
                "SELECT id, ts, view, user_text, assistant_text, nsfw, vec_json FROM exchanges ORDER BY ts DESC LIMIT 400"
            ).fetchall()
        except sqlite3.Error:
            return []
        finally:
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
    for row_id, ts, view, u_txt, a_txt, row_nsfw, vec_json in rows:
        if row_nsfw and not nsfw:
            continue
        if _fold(u_txt) in excluded or _fold(a_txt) in excluded:
            continue
        try:
            vec = json.loads(vec_json or "{}")
        except ValueError:
            vec = {}
        sim = _cosine(q_vec, vec)
        overlap = len(q_terms & companion_memory.terms(u_txt + " " + a_txt))
        score = sim + (0.12 * min(3, overlap))
        if score >= 0.24 and (overlap >= 1 or sim >= 0.32):
            scored.append((score, {
                "id": row_id,
                "ts": ts,
                "view": view,
                "user_text": u_txt,
                "assistant_text": a_txt,
                "score": round(score, 3),
            }))
    scored.sort(key=lambda item: (-item[0], -float(item[1].get("ts") or 0)))
    return [item[1] for item in scored[:limit]]


def archive_block(query: str, *, nsfw: bool = False, recent_messages: list[dict] | None = None) -> str:
    """Format top archived exchanges as a continuity page block (`ÉPISODE ÉNONCÉ — Archive`) for context assembly."""
    exclude = {str(m.get("text") or "") for m in (recent_messages or []) if isinstance(m, dict)}
    hits = search_archive(query, nsfw=nsfw, limit=2, exclude_texts=exclude)
    if not hits:
        return ""
    lines = ["ÉPISODE ÉNONCÉ (archive sémantique — échanges passés retrouvés, ne cite que si naturel) :"]
    for h in hits:
        u = re.sub(r"\s+", " ", h["user_text"]).strip()[:160]
        a = re.sub(r"\s+", " ", h["assistant_text"]).strip()[:160]
        lines.append(f"- Il disait : « {u} » → Tu répondais : « {a} »")
    return "\n".join(lines)
