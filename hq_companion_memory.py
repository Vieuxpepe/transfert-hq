"""Local, owner-scoped companion memories and follow-through. No model calls."""
from __future__ import annotations

import functools
import hashlib
import json
import math
import os
import re
import threading
import unicodedata
import uuid
from contextlib import contextmanager
from contextvars import ContextVar
from pathlib import Path
from datetime import datetime, timedelta
import hq_companion_presence as presence
import hq_companion_growth as growth
import hq_personhood
import hq_personas
import hq_visit_memory

_owner = ContextVar("companion_owner", default="admin")
# The default owner exists for single-user single-account installs, but a store
# that must not leak (relationships) can tell an explicit owner from a default.
_owner_established = ContextVar("companion_owner_established", default=False)
_memory_scope = ContextVar("companion_memory_scope", default="transferania")
_lock = threading.RLock()
_root = Path(".")


def root() -> Path:
    """The root this module is bound to, so callers read the store it reads."""
    return _root
_now = lambda: 0.0


class StoreError(RuntimeError):
    pass


def bind(*, root, now):
    global _root, _now
    _root, _now = Path(root), now


@contextmanager
def memory_scope(name: str):
    """Isolate memory JSON and personality per assistant (see ``hq_personas``).

    An unknown name raises instead of silently borrowing Transferania's store, so a
    new assistant can never write into another one's memories by accident.
    """
    key = str(name or "").strip().lower()
    if key not in hq_personas.memory_scopes():
        raise ValueError(f"portée mémoire inconnue : {name!r} (voir hq_personas)")
    token = _memory_scope.set(key)
    try:
        yield
    finally:
        _memory_scope.reset(token)


def current_owner():
    return _owner.get()


def owner_established() -> bool:
    return bool(_owner_established.get())


def set_owner(owner) -> None:
    """Mark the owner as explicitly established for the current operation."""
    _owner.set(str(owner))
    _owner_established.set(True)


@contextmanager
def owner_context(owner):
    """Temporarily act for one authenticated owner (visit writes and reads)."""
    token = _owner.set(str(owner or "admin"))
    etoken = _owner_established.set(True)
    try:
        yield
    finally:
        _owner.reset(token)
        _owner_established.reset(etoken)


def owner_request(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        owner = kwargs.get("owner_id")
        token = _owner.set(str(owner) if owner is not None else current_owner())
        etoken = _owner_established.set(owner is not None or owner_established())
        try:
            return fn(*args, **kwargs)
        finally:
            _owner.reset(token)
            _owner_established.reset(etoken)
    return wrapped


def fold(text):
    text = "".join(c for c in unicodedata.normalize("NFKD", str(text).lower()) if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", text.replace("’", "'")).strip()


def _stem(word):
    for suf in ("ements", "ement", "ations", "ation", "ures", "ure", "euses", "euse", "eurs", "eur",
                "ieres", "iere", "istes", "iste", "ables", "able", "ent", "ant", "ais", "ait",
                "ir", "er", "re", "es", "s", "ing", "ed", "ly"):
        if word.endswith(suf) and len(word) - len(suf) >= 4:
            return word[:-len(suf)]
    return word


def terms(text):
    stop = {"je", "tu", "il", "elle", "le", "la", "les", "des", "de", "du", "un", "une", "the", "a", "i", "you", "my", "mon", "ma", "mes", "sur", "on", "to", "and", "et", "est", "is", "que", "pas", "pour", "avec", "ton", "ta", "tes", "comment", "how", "what", "quel", "quelle", "bonjour", "salut", "hello", "hi", "merci", "thanks", "ok", "oui", "non", "yes", "no"}
    words = set(re.findall(r"[a-z0-9]{2,}", fold(re.sub(r"\bthé\b", "teadrink", str(text), flags=re.I)))) - stop
    out = set()
    for word in words:
        mapped = {"coffee": "cafe", "tea": "teadrink"}.get(word, word)
        out.add(mapped)
        out.add(_stem(mapped))
    return out


def path():
    key = hashlib.sha256(current_owner().encode("utf-8")).hexdigest()[:32]
    scope = _memory_scope.get()
    base = _root / ".hq-ai" / "companion-memory"
    if scope != "transferania":      # Transferania keeps the original path
        base = base / scope
    return base / (key + ".json")


def _empty():
    return {"v": 1, "revision": 0, "memories": [], "followups": [], "imported": {}, "forgotten": {},
            "presence": {}, "episodes": [], "repairs": {}, "chapters": {}, "artifact": None}


def visit_path():
    """Owner- and scope-specific visit file, beside this assistant's memory."""
    p = path()
    return p.with_name(p.stem + "_visits.json")


def record_visit(*, other_key: str, other_name: str, lines: list, source: str = "",
                 visit_id: str = "", at: float | None = None,
                 answer: dict | None = None) -> dict | None:
    return hq_visit_memory.record(visit_path(), self_key=_memory_scope.get(),
                                  other_key=other_key, other_name=other_name, lines=lines,
                                  now=_now() if at is None else at, source=source,
                                  visit_id=visit_id, answer=answer)


def recent_visit(*, other_key: str | None = None) -> dict | None:
    return hq_visit_memory.latest(visit_path(), self_key=_memory_scope.get(), other_key=other_key,
                                  now=_now())


def visit_detail(query):
    """The recall block, how old the visit behind it is, and how many back it."""
    return hq_visit_memory.hint_detail(visit_path(), self_key=_memory_scope.get(), query=query,
                                       now=_now(), stale_after=hq_personhood.SALIENCE_WARM_S)


def visit_hint(query) -> str:
    return visit_detail(query)[0]


def _load():
    try:
        if path().stat().st_size > 2 * 1024 * 1024:
            raise ValueError("Mémoire trop volumineuse")
        data = json.loads(path().read_text("utf-8"))
        if not isinstance(data, dict) or data.get("v") != 1 or any(not isinstance(data.get(k), list) for k in ("memories", "followups")):
            raise ValueError("Mémoire partagée invalide")
        data.setdefault("legacy_imported", [])
        data.setdefault("presence", {})
        data.setdefault("episodes", [])
        data.setdefault("personality", {})
        data.setdefault("personality_revision", 0)
        data.setdefault("repairs", {})
        data.setdefault("chapters", {})
        if not isinstance(data["chapters"], dict) or any(
                not isinstance(k, str) or not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0
                for k, v in data["chapters"].items()):
            raise ValueError("Chapitres invalides")
        data.setdefault("artifact", None)
        artifact = data["artifact"]
        if artifact is not None:
            if not isinstance(artifact, dict) or not {"kind", "topic", "count", "first_at", "last_at", "instances", "topics"}.issubset(artifact):
                raise ValueError("Objet accumulé invalide")
            if artifact["kind"] not in {"ritual", "list"} or not isinstance(artifact["topic"], str) \
                    or not isinstance(artifact["topics"], dict) or not isinstance(artifact["instances"], list):
                raise ValueError("Objet accumulé invalide")
            if not all(isinstance(artifact.get(k), (int, float)) and not isinstance(artifact.get(k), bool)
                       for k in ("count", "first_at", "last_at")):
                raise ValueError("Objet accumulé invalide")
        if not isinstance(data["repairs"], dict) or any(
                not isinstance(k, str) or not isinstance(v, (int, float)) or isinstance(v, bool) or v < 0
                for k, v in data["repairs"].items()):
            raise ValueError("Réparations invalides")
        if type(data["personality_revision"]) is not int or data["personality_revision"] < 0:
            raise ValueError("Révision de personnalité invalide")
        validate_personality(data["personality"], enforce_budget=False)
        if not isinstance(data.get("revision"), int) or isinstance(data["revision"], bool) or any(not isinstance(data.get(k), dict) for k in ("imported", "forgotten")):
            raise ValueError("Mémoire partagée invalide")
        if any(not isinstance(m, dict) or not {"id", "key", "kind", "subject", "polarity", "text", "status", "updated_at", "created_at", "source_device", "evidence"}.issubset(m) for m in data["memories"]):
            raise ValueError("Souvenir invalide")
        finite = lambda value: isinstance(value, (float, int)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0
        for m in data["memories"]:
            if any(not isinstance(m[k], str) for k in ("id", "key", "kind", "subject", "polarity", "text", "source_device", "evidence")) or not all(finite(m[k]) for k in ("created_at", "updated_at")):
                raise ValueError("Souvenir invalide")
            if m["status"] not in {"active", "pending_confirmation", "expired", "superseded", "forgotten"}:
                raise ValueError("État de souvenir invalide")
            if m.get("expires_at") is not None and not finite(m["expires_at"]):
                raise ValueError("Expiration invalide")
        for f in data["followups"]:
            if not isinstance(f, dict) or not {"id", "topic", "question", "status", "created_at", "updated_at", "not_before", "ask_count"}.issubset(f):
                raise ValueError("Suivi invalide")
            if any(not isinstance(f[k], str) for k in ("id", "topic", "question", "status")) or f["status"] not in {"awaiting_user", "awaiting_outcome", "resolved", "dropped", "superseded", "asked"}:
                raise ValueError("État de suivi invalide")
            if not all(finite(f[k]) for k in ("created_at", "updated_at", "not_before", "ask_count")) or any(f.get(k) is not None and not finite(f[k]) for k in ("last_asked_at", "offered_at", "asked_at")):
                raise ValueError("Suivi invalide")
            if f.get("source") not in (None, "self", "reply") or (f.get("opener") is not None and not isinstance(f.get("opener"), str)):
                raise ValueError("Origine de question invalide")
        if any(not finite(v) for v in data["forgotten"].values()) or any(not isinstance(v, int) or isinstance(v, bool) or v < 0 for v in data["imported"].values()):
            raise ValueError("Index invalide")
        if not isinstance(data["presence"], dict) or not isinstance(data["episodes"], list):
            raise ValueError("Continuité invalide")
        if any(data["presence"].get(k) is not None and not finite(data["presence"][k]) for k in ("at", "last_user_at", "return_gap", "repair_until", "callback_at")):
            raise ValueError("État de présence invalide")
        if data["presence"].get("mode", "social") not in {"social", "practical", "comfort", "recall"}:
            raise ValueError("Mode invalide")
        for episode in data["episodes"]:
            if not isinstance(episode, dict) or not all(isinstance(episode.get(k), str) for k in ("id", "text", "kind", "source_device", "evidence", "status")) or not finite(episode.get("at")):
                raise ValueError("Épisode invalide")
            if episode["kind"] not in {"outcome", "decision", "correction", "experience", "interest", "meaning", "ritual"} or episode["status"] not in {"active", "superseded", "forgotten"} or not isinstance(episode.get("topic", ""), str):
                raise ValueError("Type d'épisode invalide")
        return data
    except FileNotFoundError:
        return _empty()
    except (ValueError, OSError, TypeError, OverflowError) as error:
        raise StoreError("Mémoire partagée indisponible; aucune donnée remplacée") from error


def _save(data):
    now = _now()
    expired = lambda m: m.get("expires_at") is not None and m["expires_at"] <= now
    for m in data["memories"]:
        if m["status"] == "active" and expired(m):
            m["status"] = "expired"
    active = sorted((m for m in data["memories"] if m["status"] == "active"), key=lambda m: m["updated_at"])[-100:]
    past = [m for m in data["memories"] if m["status"] != "active"][-100:]
    data["memories"] = past + active
    pending = [f for f in data["followups"] if f["status"].startswith("awaiting")][-40:]
    closed = [f for f in data["followups"] if not f["status"].startswith("awaiting")]
    data["followups"] = closed[-(40 - len(pending)):] + pending if len(pending) < 40 else pending
    data["episodes"] = data.get("episodes", [])[-40:]
    data["revision"] += 1
    p = path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_name(p.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with tmp.open("w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, p)
    except OSError as error:
        raise StoreError("Impossible d'enregistrer la mémoire partagée") from error
    finally:
        if tmp.exists():
            tmp.unlink()


_PREFERENCE = re.compile(r"^(j'aime(?:\s+bien|\s+beaucoup)?|j'adore|je prefere|je deteste|je hais|je n'aime (?:pas|plus)|i like|i love|i prefer|i dislike|i hate|i (?:don't|do not|no longer) like)\s+(.+)$", re.I)
_PROJECT = re.compile(r"^(?:je travaille sur|je bosse sur|je dois finir|je prepare|i am working on|i'm working on|i need to finish)\s+(.+)$", re.I)
_STATE = re.compile(r"^(?:je suis|i am|i'm)\s+(?:fatigue|fatiguee|stresse|stressee|epuise|epuisee|tired|stressed|happy|super content|en pleine forme)\b", re.I)
_INSTRUCTION = re.compile(r"^(?:rappelle-toi que|n'oublie pas que|retiens que|remember that|please remember that)\s+(.+)$", re.I)
_IDENTITY = re.compile(r"^(?:appelle-moi|call me|mon prenom est|my name is)\s+(.+)$", re.I)


def extract(text):
    """Only explicit first-person statements. Questions/quotations are not facts."""
    results = []
    source = str(text).strip()
    if source.startswith(('"', "«", "“", ">", "```")) or re.match(r"^(?:if|imagine|suppose|pretend|si|imaginons|admettons)\b", fold(source)):
        return []
    source = re.sub(r'"[^"]*"|«[^»]*»|“[^”]*”|```[\s\S]*?```', "", source)
    source = re.sub(r"\s+(?:mais|but)\s+(?=(?:je\s|j['’]|i\s))", "\n", source, flags=re.I)
    for sentence in re.split(r"(?<=[.!?])\s+|\n+", source):
        sentence = sentence.strip().rstrip(".! ")
        if not sentence or "?" in sentence or len(sentence) > 500 or sentence.startswith(('"', "«", ">", "```")):
            continue
        normalized = fold(sentence)
        normalized = re.sub(r"^(?:en fait|finalement|actually|correction)[,:]?\s+", "", normalized)
        pref, project, instruction = _PREFERENCE.match(normalized), _PROJECT.match(normalized), _INSTRUCTION.match(normalized)
        if pref:
            subject = re.sub(r"^(?:le|la|les|du|de la|des|the|a|an)\s+", "", pref.group(2)).strip()
            subject = re.sub(r"\s+(?:anymore|maintenant|desormais)$", "", subject)
            subject = {"coffee": "cafe", "tea": "teadrink", "the": "teadrink"}.get(subject, subject)
            negative = bool(re.search(r"deteste|hais|n'aime|dislike|hate|don't|do not|no longer", pref.group(1)))
            results.append({"kind": "preference", "subject": subject, "polarity": "negative" if negative else "positive", "text": sentence})
        elif project:
            results.append({"kind": "project", "subject": project.group(1), "polarity": "neutral", "text": sentence})
        elif _STATE.match(normalized):
            results.append({"kind": "state", "subject": "current_state", "polarity": "neutral", "text": sentence})
        elif _IDENTITY.match(normalized):
            results.append({"kind": "fact", "subject": "display_name", "polarity": "neutral", "text": sentence})
        elif instruction:
            results.append({"kind": "fact", "subject": instruction.group(1), "polarity": "neutral", "text": sentence})
    return results[:8]


def _remember(data, item, device, at, *, historical=False, evidence="explicit_statement"):
    key = item["kind"] + ":" + item["subject"]
    stamp = hashlib.sha256(key.encode()).hexdigest()[:24]
    if historical and stamp in data.get("forgotten", {}):
        return
    matches = [m for m in data["memories"] if m["key"] == key and m["status"] == "active"]
    old = matches[-1] if matches else None
    if historical and any(m["key"] == key and m["updated_at"] >= at for m in data["memories"]):
        return
    if old and historical and old["updated_at"] >= at:
        return
    if old and fold(old["text"]) == fold(item["text"]):
        old["updated_at"] = max(old["updated_at"], at)
        return
    if old:
        old["status"] = "superseded"
    entry = {**item, "id": uuid.uuid4().hex, "key": key, "status": "active", "evidence": evidence,
             "created_at": at, "updated_at": at, "source_device": device,
             "source_text": item["text"], "expires_at": at + 6 * 3600 if item["kind"] == "state" else None}
    data["memories"].append(entry)


def _project_followup(data, item, device, at):
    if item["kind"] == "project":
        topic = item["subject"]
        if not any(f["topic"] == topic and f["status"].startswith("awaiting") for f in data["followups"]):
            data["followups"].append({"id": uuid.uuid4().hex, "topic": topic, "question": "Comment avance « " + topic + " » ?",
                "linked_key": "project:" + item["subject"],
                "status": "awaiting_outcome", "created_at": at, "updated_at": at, "source_device": device,
                "not_before": at + 86400, "last_asked_at": None, "offered_at": None, "ask_count": 0})


AUTHOR_DELAY = 2 * 86400
AUTHOR_MAX_OPEN = 3


def _question_for(opener: str, topic: str) -> str:
    """A question in her own words, fixed text, chosen by what opened it.

    Deterministic on purpose: she is not asking the model what to wonder, and the
    exact sentence is stored so the recall view can show what she wrote.
    """
    topic = str(topic or "").strip()[:120]
    if not topic:
        return ""
    return {
        "repair": "Est-ce que « " + topic + " » a changé pour toi, ou seulement pour moi ?",
        "correction": "Qu'est-ce qui t'a fait changer d'avis sur « " + topic + " » ?",
        "thread": "Où est-ce que tu veux emmener « " + topic + " » ?",
    }.get(opener, "")


def _author_question(data, *, topic, opener, text, now, device=""):
    """Jot a question of her own when something opens; ask it days later, once.

    It is a follow-up row like any other — same store, same reservation, same
    trim — with ``source: "self"`` so it stays inspectable and never competes
    with a question the Master was already asked. No duplicate topic, no more
    than a few open at a time, and a topic she already asked about stays quiet.
    """
    topic = str(topic or "").strip()[:160]
    key = fold(topic)
    if not key or not text:
        return None
    open_rows = [f for f in data["followups"] if f.get("source") == "self"
                 and f["status"] == "awaiting_user"]
    if len(open_rows) >= AUTHOR_MAX_OPEN:
        return None
    if any(fold(f.get("topic")) == key and f.get("source") == "self" and f["status"] == "awaiting_user"
           for f in data["followups"]):
        return None
    if any(fold(f.get("topic")) == key and f.get("source") == "self" and f["status"] == "asked"
           and now - float(f.get("asked_at") or 0) < 30 * 86400 for f in data["followups"]):
        return None
    row = {"id": uuid.uuid4().hex, "topic": topic, "question": str(text)[:240],
           "linked_key": None, "status": "awaiting_user", "source": "self", "opener": opener,
           "created_at": now, "updated_at": now, "source_device": device,
           "not_before": now + AUTHOR_DELAY, "last_asked_at": None, "offered_at": None,
           "asked_at": None, "ask_count": 0}
    data["followups"].append(row)
    return row


def _record_artifact(data, episode):
    """One object per sister, accumulated from stored events: it never resets.

    Transferania keeps what they do again and again (ritual episodes); Else keeps
    the list of things he said he would settle (decision episodes). The object
    survives new topics: it counts the whole history and names the topic that
    actually repeats.
    """
    scope = _memory_scope.get()
    kind = "ritual" if scope != "else" else "list"
    wanted = "ritual" if kind == "ritual" else "decision"
    if episode.get("kind") != wanted:
        return
    topic = str(episode.get("topic") or "").strip()[:160]
    if not topic:
        return
    at = float(episode.get("at") or _now())
    art = data.get("artifact")
    if not isinstance(art, dict) or art.get("kind") != kind:
        art = {"kind": kind, "topic": topic, "count": 0, "first_at": at, "last_at": at,
               "topics": {}, "instances": [], "updated_at": at}
    art["count"] = int(art.get("count") or 0) + 1
    art["topics"][topic] = int((art.get("topics") or {}).get(topic) or 0) + 1
    top = max(art["topics"].values())
    repeated = [name for name, seen in art["topics"].items() if seen == top]
    art["topic"] = next((row["topic"] for row in reversed(art.get("instances") or [])
                         if row.get("topic") in repeated), repeated[0])
    art["first_at"] = min(float(art.get("first_at") or at), at)
    art["last_at"] = max(float(art.get("last_at") or at), at)
    art["updated_at"] = _now()
    art["instances"] = (list(art.get("instances") or [])
                        + [{"id": episode.get("id"), "at": at, "topic": topic,
                            "text": str(episode.get("text") or "")[:240]}])[-8:]
    data["artifact"] = art


def _artifact_phrase(art) -> str:
    """Phrasing decided by how many times the object has actually come back."""
    if not isinstance(art, dict) or not art.get("count"):
        return ""
    count = int(art["count"])
    if art.get("kind") == "ritual":
        if count == 1:
            return "première fois — aucune habitude encore"
        if count == 2:
            return "deuxième fois — ça commence à tenir"
        if count <= 4:
            return "%s fois — ce n'est plus un hasard" % ("troisième" if count == 3 else "quatrième")
        return "c'est devenu notre chose — %d fois" % count
    if count == 1:
        return "un point noté"
    if count == 2:
        return "deux points notés"
    return "%d points notés, la liste tient toute seule" % count


def _artifact_view(art):
    if not isinstance(art, dict) or not art.get("count"):
        return None
    return {"kind": art.get("kind"), "topic": art.get("topic"), "count": int(art["count"]),
            "phrase": _artifact_phrase(art), "first_at": art.get("first_at"),
            "last_at": art.get("last_at"), "instances": len(art.get("instances") or [])}


def _artifact_touched(art, text) -> bool:
    """Whether this message is about the accumulated object, by topic or instance."""
    wanted = terms(text)
    if wanted & terms(art.get("topic") or ""):
        return True
    return any(wanted & terms(str(row.get("topic") or "") + " " + str(row.get("text") or ""))
               for row in art.get("instances") or [])


def _artifact_page(art) -> str:
    """The accumulated object as one bounded page block, phrased by its count."""
    if not isinstance(art, dict) or not art.get("count"):
        return ""
    head = "RITUEL QUI S'ACCUMULE" if art.get("kind") == "ritual" else "LISTE TENUE"
    body = "« %s » : %s. Première trace le %s, la dernière le %s." % (
        art.get("topic") or "", _artifact_phrase(art),
        hq_personhood._date(float(art.get("first_at") or 0)),
        hq_personhood._date(float(art.get("last_at") or 0)))
    return head + " :\n" + body + " (cumul de faits enregistrés, pas une humeur)"


def migrate(device, thread):
    """Import this authenticated device only; never scan other conversations."""
    with _lock:
        data = _load()
        marker = data["imported"].get(device, 0)
        messages = thread.get("messages") or []
        legacy_done = device in data.get("legacy_imported", [])
        if marker >= len(messages) and legacy_done:
            return
        for m in messages[marker:][-500:]:
            if m.get("role") != "user":
                continue
            at = m.get("ts", 0)
            at = float(at) if isinstance(at, (int, float)) and math.isfinite(at) else 0
            for item in extract(m.get("text", "")):
                _remember(data, item, device, at, historical=True)
        data["imported"][device] = len(messages)
        if not legacy_done:
            for raw in (thread.get("facts") or [])[-30:]:
                text = str(raw.get("text", "") if isinstance(raw, dict) else raw).strip()[:500]
                if not text or any(text in m["text"] or fold(text) == m["subject"] for m in data["memories"]):
                    continue
                key = "legacy:" + fold(text)
                if hashlib.sha256(key.encode()).hexdigest()[:24] in data["forgotten"]:
                    continue
                data["memories"].append({"id": uuid.uuid4().hex, "kind": "legacy", "subject": fold(text), "key": key,
                    "polarity": "unknown", "text": text, "status": "pending_confirmation", "evidence": "legacy_unverified",
                    "created_at": 0, "updated_at": 0, "source_device": device, "source_text": text, "expires_at": None})
            data.setdefault("legacy_imported", []).append(device)
        _save(data)


def observe_user(text, device):
    try:
        hq_personhood.observe_chat(_memory_scope.get(), text, source=device, owner=current_owner())
    except Exception:
        pass
    now = _now()
    resolved = []
    with _lock:
        data = _load()
        data["presence"] = presence.advance(data.get("presence"), text, now)
        pending = [f for f in data["followups"] if f["status"].startswith("awaiting")]
        normal = fold(text)
        normal = re.sub(r"^(?:oui|yes|en fait|actually)[, ]+", "", normal)
        completion = "?" not in text and bool(re.match(r"^(?:j'ai fini|c'est (?:fait|termine|regle)|ca s'est bien passe|i finished|it's done|it went well|i passed)\b", normal))
        drop = bool(re.match(r"^(?:laisse tomber|n'en parle plus|drop (?:it|that)|don't ask|do not ask)\b", normal))
        for f in pending:
            related = bool(terms(f["topic"]) & terms(text))
            recently_asked = f.get("last_asked_at") is not None and now - f["last_asked_at"] < 86400
            short_answer = normal in {"oui", "non", "yes", "no", "oui merci", "non merci"}
            option_answer = recently_asked and len(pending) == 1 and len(terms(text)) <= 3 and bool(terms(f["question"]) & terms(text))
            if (completion or drop) and (related or ((recently_asked or drop) and len(pending) == 1)):
                previous_status = f["status"]
                f.update(status="dropped" if drop else "resolved", updated_at=now)
                resolved.append({**f, "previous_status": previous_status})
            elif f["status"] == "awaiting_user" and recently_asked and "?" not in text and (related or short_answer or option_answer):
                f.update(status="resolved", updated_at=now)
                resolved.append({**f, "previous_status": "awaiting_user"})
        for item in extract(text):
            key = item["kind"] + ":" + item["subject"]
            old = next((m for m in data["memories"] if m["key"] == key and m["status"] == "active"), None)
            if old and old["polarity"] != item["polarity"]:
                _record_episode(data, item["text"], "correction", device, key)
            _remember(data, item, device, now)
            _project_followup(data, item, device, now)
        for topic in resolved:
            if topic["status"] == "resolved" and topic["previous_status"] == "awaiting_outcome":
                key = topic.get("linked_key")
                if key and key.startswith("project:"):
                    for m in data["memories"]:
                        if m["key"] == key and m["status"] == "active":
                            m.update(status="superseded", updated_at=now)
                    data["forgotten"][hashlib.sha256(key.encode()).hexdigest()[:24]] = now
                _record_episode(data, text, "outcome", device, topic.get("linked_key"), topic=topic["topic"])
        if "?" not in text and re.match(r"^(?:nous avons decide|on a decide|we decided|we agreed)\b", fold(text)):
            _record_episode(data, text, "decision", device, None)
        development = growth.extract(text)
        if development:
            _record_episode(data, text, development["kind"], device, None, topic=development["topic"])
            if development["kind"] in {"decision", "experience"}:
                _author_question(data, topic=development["topic"], opener="thread",
                                 text=_question_for("thread", development["topic"]), now=now,
                                 device=device)
        _save(data)
    if not resolved:
        return ""
    result = "SUJET PARTAGÉ " + ("ABANDONNÉ" if resolved[-1]["status"] == "dropped" else "RÉSOLU") + " : " + resolved[-1]["question"] + "\nRéponse explicite : " + text
    if resolved[-1]["status"] == "resolved":
        reason = growth.meaning_for(growth.derive(data["episodes"], now), resolved[-1]["topic"], terms=terms)
        if reason:
            result += "\n" + reason
    return result


def observe_reply(user_text, reply, device):
    now = _now()
    questions = [s.strip() for s in re.split(r"(?<=[.!?])\s+", reply) if s.strip().endswith("?")]
    if not questions:
        return
    # Read before the store lock: the personhood gate must never nest inside it.
    try:
        withheld = hq_personhood.withholds_initiative(_memory_scope.get(), owner=current_owner(), now=now)
    except Exception:
        withheld = False
    with _lock:
        data = _load()
        for question in questions[-1:]:
            matching = [f for f in data["followups"] if f["status"].startswith("awaiting") and terms(f["topic"]) & terms(question)]
            if matching:
                matching[-1].update(last_asked_at=now, offered_at=now, ask_count=matching[-1]["ask_count"] + 1)
                continue
            if withheld:
                # She asked while tense; do not enshrine that as a future nudge.
                # Nothing is pending yet, so nothing is deleted either.
                continue
            items = extract(user_text)
            topic = items[0]["subject"] if items else user_text.strip()
            if len(terms(topic)) < 1 or len(terms(question)) < 2 or not (terms(topic) & terms(question)):
                continue
            # A question she already wrote on this topic owns it: the model
            # restating it must not make the pipeline ask it a second time.
            if any(fold(row.get("topic")) == fold(topic) and row.get("source") == "self"
                   for row in data["followups"]):
                continue
            data["followups"].append({"id": uuid.uuid4().hex, "topic": topic[:160], "question": question[:240],
                "linked_key": (items[0]["kind"] + ":" + topic) if items else None,
                "status": "awaiting_user", "created_at": now, "updated_at": now, "source_device": device,
                "not_before": now + 86400, "last_asked_at": now, "offered_at": now, "ask_count": 1})
        _save(data)


def _record_episode(data, text, kind, device, key, *, topic=None):
    if not str(text).strip() or len(text) > 500:
        return
    if any(fold(e["text"]) == fold(text) and e["status"] == "active"
           and (kind not in {"interest", "experience", "meaning", "ritual"}
                or datetime.fromtimestamp(e["at"]).date() == datetime.fromtimestamp(_now()).date())
           for e in data["episodes"]):
        return
    if kind == "correction" and key:
        for episode in data["episodes"]:
            if episode.get("source_key") == key and episode["kind"] == "correction":
                episode["status"] = "superseded"
    episode = {"id": uuid.uuid4().hex, "text": str(text).strip(), "kind": kind,
        "topic": str(topic or (key.partition(":")[2] if key else ""))[:160],
        "source_device": device, "source_key": key, "at": _now(), "evidence": "user_statement", "status": "active"}
    data["episodes"].append(episode)
    _record_artifact(data, episode)


REPAIR_WINDOW = 90 * 86400
# The recall page is read inside the same protected share as the correction it
# describes; it carries a few whole rows, not the whole archive.
REPAIR_LEDGER_MAX_ROWS = 3
REPAIR_LEDGER_MAX_BYTES = 520
_REPAIR_LEDGER_ASK = re.compile(
    r"qu'est-ce que tu disais|ce que (?:je|tu) disais|tu disais (?:avant|deja)|reparations?|"
    r"corrections? (?:du|de) (?:journal|memoire)|tes corrections|historique des corrections|"
    r"ce que tu as change")


def _repair_pairs(data):
    """Every place the archive still holds both the old answer and the new one.

    One finder for both the dialogue line and the recall view, so the two can
    never disagree about what the ledger contains.
    """
    memories = [m for m in data.get("memories", []) if isinstance(m, dict)]
    found = []
    for new in memories:
        if new.get("status") != "active" or new.get("evidence") != "user_correction":
            continue
        previous = [m for m in memories
                    if m.get("key") == new.get("key") and m.get("status") == "superseded"
                    and fold(m.get("text")) != fold(new.get("text"))]
        if not previous:
            continue
        old = max(previous, key=lambda m: float(m.get("updated_at") or 0))
        found.append({"id": str(new.get("id") or ""), "topic": str(new.get("subject") or ""),
                      "old": str(old.get("text") or ""), "new": str(new.get("text") or ""),
                      "since": float(new.get("updated_at") or 0),
                      "old_id": str(old.get("id") or ""), "new_id": str(new.get("id") or "")})
    episodes = [e for e in data.get("episodes", []) if isinstance(e, dict)]
    for new in episodes:
        if new.get("status") != "active" or new.get("evidence") != "user_correction":
            continue
        since = new.get("corrected_at")
        if not isinstance(since, (int, float)) or isinstance(since, bool):
            continue
        previous = [e for e in episodes
                    if e.get("status") == "superseded" and e.get("kind") == new.get("kind")
                    and fold(e.get("topic")) == fold(new.get("topic"))
                    and fold(e.get("text")) != fold(new.get("text"))]
        if not previous:
            continue
        old = max(previous, key=lambda e: float(e.get("at") or 0))
        found.append({"id": str(new.get("id") or ""), "topic": str(new.get("topic") or ""),
                      "old": str(old.get("text") or ""), "new": str(new.get("text") or ""),
                      "since": float(since),
                      "old_id": str(old.get("id") or ""), "new_id": str(new.get("id") or "")})
    return found


def repair_records(data, now=None):
    """What she used to say and says now, read only from the correction archive.

    ``correct`` marks the memory it replaces ``superseded`` and leaves its own
    words there; the active row that replaces it carries the moment it took
    over. Two texts that differ under the same key are therefore a repair, and
    the date is the replacement's — never a guess. Episodes count only when they
    recorded when they were corrected, because without that field there is no
    honest "since". At most one record per topic survives, newest first.
    """
    stamp = float(now if now is not None else _now())
    seen, rows = set(), []
    for pair in sorted(_repair_pairs(data), key=lambda p: p["since"], reverse=True):
        topic = fold(pair["topic"]).strip()
        if not topic or not pair["old"].strip() or not pair["new"].strip():
            continue
        if not 0 <= stamp - pair["since"] <= REPAIR_WINDOW or topic in seen:
            continue
        seen.add(topic)
        rows.append({k: pair[k] for k in ("id", "topic", "old", "new", "since")})
    return rows


# Two sisters, one archive shape: each reads the same stored day for a different
# kind of evidence. The lens is a declared preference over episode kinds, so the
# surfaced rows can be compared and tested, not just felt in adjectives.
LENS = {
    "transferania": {"label": "le rituel, le sens et le ton",
                     "prefers": ("ritual", "meaning", "interest", "repair")},
    "else": {"label": "la correction, la décision et le résultat",
             "prefers": ("correction", "decision", "outcome", "project")},
}
LENS_WINDOW = 90 * 86400


def lens_select(data, scope, now, *, limit=5):
    """Which stored evidence this sister would surface for the very same day."""
    lens = LENS.get(str(scope or "transferania"), LENS["transferania"])
    prefs = list(lens["prefers"])
    rows, counts = [], {}
    for episode in data.get("episodes", []):
        if not isinstance(episode, dict) or episode.get("status") != "active":
            continue
        at = float(episode.get("at") or 0)
        if not 0 <= now - at <= LENS_WINDOW:
            continue
        kind = str(episode.get("kind") or "")
        rank = (len(prefs) - prefs.index(kind)) if kind in prefs else 0
        rows.append({"id": episode.get("id"), "kind": kind, "topic": episode.get("topic") or "",
                     "at": at, "rank": rank, "reason": "préféré" if rank else "présent"})
    if "repair" in prefs:
        for record in repair_records(data, now):
            rows.append({"id": record["id"], "kind": "repair", "topic": record["topic"],
                         "at": record["since"], "rank": len(prefs) - prefs.index("repair"),
                         "reason": "préféré"})
    rows.sort(key=lambda row: (row["rank"], row["at"]), reverse=True)
    for row in rows:
        counts[row["kind"]] = counts.get(row["kind"], 0) + 1
    return {"name": scope if scope in LENS else "transferania", "label": lens["label"],
            "prefers": prefs, "surfaced": rows[:limit], "counts": counts}


QUIET_WINDOW = 90 * 86400


def quiet_state(data, now):
    """Why she is already quiet on one subject, said in plain words.

    Derived from the counters the pause itself uses: correction episodes on one
    topic inside the window, and the ladder step those open corrections imply.
    No new score, no reading of his feelings.
    """
    by_topic = {}
    for episode in data.get("episodes", []):
        if not isinstance(episode, dict) or episode.get("kind") != "correction":
            continue
        at = float(episode.get("at") or 0)
        if not 0 <= now - at <= QUIET_WINDOW:
            continue
        topic = str(episode.get("topic") or "").strip()
        if topic:
            by_topic.setdefault(fold(topic), []).append((topic, at))
    if not by_topic:
        return {"withheld": False}
    _, rows = max(by_topic.items(), key=lambda item: (len(item[1]), max(at for _, at in item[1])))
    topic = rows[-1][0]
    count = len(rows)
    state = hq_personhood.salience(now - max(at for _, at in rows), 1, pushback=count)
    withheld = bool(state.get("withhold"))
    days = max(1, int(round((now - min(at for _, at in rows)) / 86400)))
    return {"withheld": withheld, "topic": topic, "corrections": count,
            "window_days": int(QUIET_WINDOW / 86400), "rung": state.get("rung"),
            "share": state.get("share"),
            "says": ("« %s » : tu m'as corrigée %d fois en %d jours — je me tais sur ce sujet "
                     "tant que tu n'y reviens pas." % (topic, count, days)) if withheld else ""}


CHAPTER_WINDOW = 90 * 86400


def chapter_records(data, now):
    """Closed chapters, read only from stored episodes.

    A chapter is an ``outcome`` episode over a subject that was opened before it:
    the opening is the earliest stored episode on that topic, or the memory row
    that carried it. A subject reopened after its outcome is not closed and gets
    no chapter. Nothing is inferred about how it went beyond the recorded text.
    """
    stamp = float(now)
    episodes = [e for e in data.get("episodes", []) if isinstance(e, dict)]
    memories = [m for m in data.get("memories", []) if isinstance(m, dict)]
    found = []
    for outcome in episodes:
        if outcome.get("status") != "active" or outcome.get("kind") != "outcome":
            continue
        closed = _stamp(outcome.get("at"))
        if closed is None or not 0 <= stamp - closed <= CHAPTER_WINDOW:
            continue
        topic = str(outcome.get("topic") or "").strip()
        key = fold(topic).strip()
        if not key:
            continue
        if any(e is not outcome and e.get("status") == "active" and e.get("kind") != "outcome"
               and fold(e.get("topic")) == key and (_stamp(e.get("at")) or 0) > closed
               for e in episodes):
            continue  # it was reopened: not a closed chapter
        opened = [e for e in episodes if e is not outcome and fold(e.get("topic")) == key
                  and (_stamp(e.get("at")) or 0) <= closed]
        opening = min(opened, key=lambda e: _stamp(e.get("at")) or closed) if opened else None
        opened_at = _stamp(opening.get("at")) if opening else None
        if opened_at is None:
            rows = [m for m in memories if fold(m.get("subject")) == key]
            if rows:
                opened_at = min((_stamp(m.get("created_at")) or closed) for m in rows)
        opened_at = closed if opened_at is None else opened_at
        found.append({"id": str(outcome.get("id") or ""), "topic": topic,
                      "opened_at": float(opened_at), "closed_at": float(closed),
                      "days": max(0, int(round((closed - opened_at) / 86400))),
                      "outcome": str(outcome.get("text") or ""),
                      "opened_id": str(opening.get("id") or "") if opening else "",
                      "closed_id": str(outcome.get("id") or ""), "basis": "chapter"})
    seen, rows = set(), []
    for row in sorted(found, key=lambda r: r["closed_at"], reverse=True):
        key = fold(row["topic"]).strip()
        if key in seen:
            continue
        seen.add(key)
        rows.append(row)
    return rows


def _stamp(value):
    return float(value) if isinstance(value, (int, float)) and not isinstance(value, bool) else None


def _repair_view(data, stamp):
    """The ledger read back: every repair, and every one it cannot rebuild.

    Complete rows come from ``repair_records`` unchanged — the dialogue line and
    this view cannot drift. A correction whose replaced answer was pruned, or
    whose change date was never recorded, is still named by the fields that do
    exist, with ``missing`` spelling out what the ledger no longer holds. Nothing
    is inferred to fill a gap.
    """
    complete = repair_records(data, stamp)
    pairs = {p["id"]: p for p in _repair_pairs(data)}
    rows, topics = [], set()
    for record in complete:
        pair = pairs.get(record["id"]) or {}
        topics.add(fold(record["topic"]).strip())
        rows.append({"topic": record["topic"], "old": record["old"], "new": record["new"],
                     "since": record["since"], "basis": "repair", "complete": True, "missing": [],
                     "evidence": {"live": str(pair.get("new_id") or record["id"]),
                                  "superseded": str(pair.get("old_id") or "")}})

    def partial(topic, new, old, since, live, superseded):
        key = fold(topic).strip()
        if not key or key in topics or not (new or old):
            return
        topics.add(key)
        missing = [name for name, value in (("old", old), ("since", since)) if value is None]
        rows.append({"topic": str(topic), "old": old, "new": new, "since": since,
                     "basis": "repair", "complete": False, "missing": missing,
                     "evidence": {"live": str(live or ""), "superseded": str(superseded or "")}})

    # A correction row whose replaced row is gone: the new words and the moment
    # they took over survive, the old answer does not.
    for row in [m for m in data.get("memories", []) if isinstance(m, dict)]:
        if row.get("status") != "active" or row.get("evidence") != "user_correction":
            continue
        partial(row.get("subject") or "", str(row.get("text") or "") or None, None,
                _stamp(row.get("updated_at")), row.get("id"), None)
    # An episode corrected before ``corrected_at`` existed: the words are there,
    # the date of the change was never kept.
    episodes = [e for e in data.get("episodes", []) if isinstance(e, dict)]
    for new in episodes:
        if new.get("status") != "active" or new.get("evidence") != "user_correction":
            continue
        previous = [e for e in episodes if e.get("status") == "superseded"
                    and fold(e.get("topic")) == fold(new.get("topic"))
                    and fold(e.get("text")) != fold(new.get("text"))]
        old = max(previous, key=lambda e: float(e.get("at") or 0)) if previous else None
        partial(new.get("topic") or "", str(new.get("text") or "") or None,
                str(old.get("text") or "") if old else None, _stamp(new.get("corrected_at")),
                new.get("id"), old.get("id") if old else None)
    return {"ok": True, "revision": data.get("revision"), "rows": rows,
            "complete_count": len(complete), "partial_count": len(rows) - len(complete)}


def repair_ledger(now=None):
    """Read-only recall view of the correction ledger. Stamps and reserves nothing."""
    with _lock:
        data = _load()
        return _repair_view(data, float(now if now is not None else _now()))


def wants_repair_ledger(query) -> bool:
    """He asked to see the ledger itself, not to talk about one subject."""
    return bool(_REPAIR_LEDGER_ASK.search(fold(query)))


def _ledger_page(view) -> str:
    """Bounded page block: whole rows inside the protected share, and a count for
    whatever did not fit, so a short page never looks like an empty ledger."""
    rows = list(view.get("rows") or [])
    if not rows:
        return ""
    MISSING = {"old": "l'ancienne réponse", "since": "la date du changement"}
    lines, used, shown = [], 0, 0
    for row in rows:
        if shown >= REPAIR_LEDGER_MAX_ROWS:
            break
        proof = "journal : " + (row["evidence"]["live"][:8] or "?")
        if row["evidence"]["superseded"]:
            proof += " / " + row["evidence"]["superseded"][:8]
        if row["complete"]:
            line = "— « %s » : je disais « %s » ; depuis le %s je dis « %s » (%s)" % (
                row["topic"], row["old"], hq_personhood._date(row["since"]), row["new"], proof)
        else:
            said = "je dis « %s »" % row["new"] if row["new"] else "je ne sais plus quoi je dis"
            dated = "depuis le " + hq_personhood._date(row["since"]) if row["since"] else "date inconnue"
            lacked = " et ".join(MISSING[name] for name in row["missing"] if name in MISSING) or "un champ"
            line = "— « %s » : %s, %s ; il manque %s — non reconstruite (%s)" % (
                row["topic"], said, dated, lacked, proof)
        cost = len(line.encode("utf-8")) + 1
        if used + cost > REPAIR_LEDGER_MAX_BYTES:
            break
        lines.append(line)
        used += cost
        shown += 1
    if len(rows) > shown:
        lines.append("(%d réparation(s) de plus dans la vue Mémoire)" % (len(rows) - shown))
    return "RÉPARATIONS DU JOURNAL (ce que je disais, ce que je dis maintenant) :\n" + "\n".join(lines)


def context(query, *, reserve_followup=False):
    packet = context_packet(query, reserve_followup=reserve_followup)
    return packet["memories"], packet["continuity"]


def context_packet(query, *, reserve_followup=False, conversation_text=None, allow_followup=True,
                   persist=True):
    # A tense grade closes the initiative structurally, not by asking the model
    # to hold back: no pending follow-up is offered and no callback is planted.
    # Read before the store lock, so the two modules never nest their locks.
    try:
        withheld = hq_personhood.withholds_initiative(_memory_scope.get(), owner=current_owner(), now=_now())
    except Exception:
        withheld = False
    with _lock:
        data = _load()
        now = _now()
        # Each sister reads the same stored day through her own lens: Else for the
        # correction and the plan, Transferania for the ritual and the tone.
        lens = lens_select(data, _memory_scope.get(), now)
        active = [m for m in data["memories"] if m["status"] == "active" and (m.get("expires_at") is None or m["expires_at"] > now)]
        generic = bool(re.search(r"souviens|souvenir|preferences|remember|know about me|what do i like", fold(query)))
        ranked = [(len(terms(m["text"]) & terms(query)), m["updated_at"], m) for m in active]
        ranked.sort(key=lambda r: (r[0], r[1]), reverse=True)
        selected = [m["text"] for relevance, _, m in ranked if relevance or generic][:5]
        views = growth.derive(data["episodes"], now)
        requested = growth.requested_kind(conversation_text if conversation_text is not None else query)
        request_terms = terms(conversation_text if conversation_text is not None else query)
        general_interest = requested == "interest" and growth.general_interest_request(conversation_text if conversation_text is not None else query)
        candidates = [(len(request_terms & terms(c["topic"])), c["updated_at"], c)
                      for c in views if c["kind"] == requested and (general_interest or request_terms & terms(c["topic"]))]
        candidates.sort(key=lambda c: (c[0], c[1]), reverse=True)
        view = candidates[0][2] if candidates else None
        if view:
            selected = [growth.render(view)] + selected[:4]
        due = [f for f in data["followups"] if f["status"].startswith("awaiting") and now >= f["not_before"]
               and (f.get("offered_at") is None or now - f["offered_at"] >= 21600)
               and (conversation_text is None or not terms(conversation_text) or bool(terms(conversation_text) & terms(f["topic"])))]
        if withheld:
            # The record stays pending for a calmer turn; it is simply not put
            # in front of her now, and nothing is reserved for it.
            due = []
        followup = due[0] if due else None
        state = data["presence"]
        mode = presence.classify(conversation_text) if conversation_text is not None else state.get("mode", "social") if now - state.get("at", 0) < 1800 else "social"
        recall = mode == "recall"
        episode_query = conversation_text if conversation_text is not None else query
        # The ledger itself, when he asks to see it. Reading it stamps nothing and
        # reserves nothing, so a later real turn still holds the one-time line.
        ledger = _repair_view(data, now) if wants_repair_ledger(episode_query) else None
        ledger_page = _ledger_page(ledger) if ledger else ""
        # An unresolved repair suppresses every unsolicited callback.
        repair_active = state.get("repair_until", 0) > now
        # The accumulated object speaks on its own topic, or when he asks to look
        # back at what the two of them have actually built up.
        artifact = data.get("artifact") if isinstance(data.get("artifact"), dict) else None
        artifact_page = ""
        # Forgetting the source retracts the accumulated object with it: the page
        # only speaks for a thread the ledger still holds.
        tracked = {fold(str(e.get("topic") or "")) for e in data["episodes"] if e["status"] == "active"}
        if artifact and artifact.get("count") and fold(str(artifact.get("topic") or "")) in tracked:
            # Practical requests and comfort suppress unsolicited callbacks, so
            # the accumulated object may speak on its topic only in a social turn.
            if not repair_active and (recall or (mode == "social" and _artifact_touched(artifact, episode_query))):
                artifact_page = _artifact_page(artifact)
        episodes = [e for e in data["episodes"] if e["status"] == "active" and now - e["at"] <= 90 * 86400]
        scored = [(len(terms(episode_query) & terms(e["text"] + " " + e.get("topic", ""))), e["at"], e) for e in episodes]
        # Relevance decides first; this sister's lens breaks the tie between two
        # equally relevant pieces, which is where the two accounts diverge.
        weights = {kind: len(lens["prefers"]) - index for index, kind in enumerate(lens["prefers"])}
        scored.sort(key=lambda r: (r[0], weights.get(r[2]["kind"], 0), r[1]), reverse=True)
        generic_recall = recall and bool(re.search(r"what do you remember|last time|dernier.*(?:fois|moment)|de quoi.*souviens", fold(episode_query)))
        episode = next((e for relevance, _, e in scored if relevance or generic_recall), None)
        callback_cooled = state.get("callback_at") is None or now - state["callback_at"] >= 21600
        callback_ready = (not withheld) and state.get("return_gap", 0) >= 21600 and callback_cooled
        # Let a reinforced interest or an explicitly named ritual colour a
        # relevant social exchange without requiring a memory quiz or a return.
        # It still shares the one continuity slot and six-hour cooldown.
        motif = (growth.natural_callback(views, episode_query, terms=terms)
                 if not requested and mode == "social" and callback_cooled
                 and not withheld and not repair_active else None)
        if motif:
            episode = next(e for e in episodes if e["id"] == motif["source_ids"][-1])
        decision = presence.arbitrate({**state, **({"mode": mode, "at": now} if conversation_text is not None else {})}, now=now,
            has_followup=bool(followup and allow_followup), has_episode=bool(episode and (recall or callback_ready or motif)), explicit_recall=recall)
        if view:
            # A requested reflection already occupies the one continuity slot.
            decision["continuity_kind"] = "none"
        if not allow_followup and not recall:
            decision["continuity_kind"] = "none"
        reservation = None
        if decision["continuity_kind"] == "followup" and reserve_followup:
            followup["offered_at"] = now
            if followup.get("source") == "self":
                # Her own question is asked once and then closed: never re-asked.
                followup.update(status="asked", asked_at=now, updated_at=now,
                                ask_count=int(followup.get("ask_count") or 0) + 1)
            reservation = {"kind": "followup", "id": followup["id"], "at": now,
                           "self": followup.get("source") == "self"}
            _save(data)
        hint = ""
        personhood = {}
        repair = None
        chapter = None
        ritual_available = bool(view and view["kind"] == "ritual")
        if decision["continuity_kind"] == "followup":
            hint = "SUJET EN ATTENTE (une seule relance si le moment convient, sans inventer de résultat) : " + followup["question"]
            reason = growth.meaning_for(views, followup["topic"], terms=terms)
            if reason:
                hint += "\n" + reason
        elif decision["continuity_kind"] == "episode":
            # A recorded outcome is a past chapter, not a live thread: the slot
            # keeps its episode decision, but the line is her dated chapter, said
            # once — and a preview says it without spending the record.
            closed_chapter = next((c for c in chapter_records(data, now)
                                   if c["closed_id"] == episode["id"]), None)
            if closed_chapter is not None and closed_chapter["id"] not in (data.get("chapters") or {}):
                chapter = {"id": closed_chapter["id"], "topic": closed_chapter["topic"],
                           "opened_at": closed_chapter["opened_at"],
                           "closed_at": closed_chapter["closed_at"],
                           "days": closed_chapter["days"], "basis": "chapter"}
                hint = hq_personhood.chapter_line(closed_chapter)
                if reserve_followup and not recall:
                    state["callback_at"] = now
                    _save(data)
            else:
                hint = "ÉPISODE ÉNONCÉ PAR L'UTILISATEUR (" + datetime.fromtimestamp(episode["at"]).strftime("%Y-%m-%d") + "; sujet : " + episode.get("topic", "") + ") : " + re.sub(r"\s+", " ", episode["text"])
                related_view = next((c for c in views if episode["id"] in c["source_ids"]), None)
                if related_view:
                    ritual_available = related_view["kind"] == "ritual"
                    hint = growth.render(related_view)
                    if not recall:
                        hint += " ÉVOLUTION VÉCUE : laisse ce fil infléchir ton avis ou un clin d'œil discret; ne récite pas une fiche mémoire."
                elif episode["kind"] == "outcome":
                    reason = growth.meaning_for(views, episode.get("topic", ""), terms=terms)
                    if reason:
                        hint += "\n" + reason
                if reserve_followup and not recall:
                    state["callback_at"] = now
                    reservation = {"kind": "episode", "id": episode["id"], "at": now}
                    _save(data)
        if not hint and conversation_text is not None:
            # A visit is a second, separate kind of continuity: it may fill the
            # empty slot, but never displaces a follow-up or an episode, and it
            # stays out of ambient lines that have no conversational turn.
            # An explicit recall still gets its visit; only the unprompted
            # continuity offer is closed by a tense grade.
            visit_recall, visit_age, visit_repeats = (
                ("", None, 1) if (withheld and not recall) else visit_detail(episode_query))
            if visit_recall:
                hint = visit_recall
                # The recall page ranks by the visit it quotes instead of a fixed
                # personhood priority: an old visit sits below a fresh one, and a
                # sister visited again and again reaches the hot band her line
                # would, because repeats comes from the log, not a constant.
                personhood = {**hq_personhood.salience(visit_age, visit_repeats),
                              "basis": "visit_recall"}
            elif conversation_text is not None:
                try:
                    # The correction archive is the record of the Master pushing
                    # back: repetitions about one subject lower its salience, even
                    # though only the latest stays active.
                    pushback = [{"topic": e.get("topic") or "", "text": e.get("text") or "",
                                 "at": e.get("at")}
                                for e in data["episodes"] if e.get("kind") == "correction"]
                    # What she used to say and says now, from the archive alone; the
                    # mark says which of those records has already been told.
                    repairs = repair_records(data, now)
                    marks = data.get("repairs") if isinstance(data.get("repairs"), dict) else {}
                    for record in repairs:
                        record["quoted"] = record["id"] in marks
                    # A subject with a recorded outcome is a past chapter, not a
                    # pending thread; it is marked once it has been told.
                    chapters = chapter_records(data, now)
                    told_marks = data.get("chapters") if isinstance(data.get("chapters"), dict) else {}
                    for record in chapters:
                        record["quoted"] = record["id"] in told_marks
                    detail = hq_personhood.hint_detail(_memory_scope.get(), episode_query,
                                                      owner=current_owner(), now=now, pushback=pushback,
                                                      repairs=repairs, chapters=chapters, persist=persist)
                    hint = detail.get("line") or ""
                    # The line comes with the salience its own evidence implies:
                    # how present that subject is decides its priority and bytes.
                    personhood = {k: detail[k] for k in ("tier", "rung", "base", "score",
                                                         "priority", "share", "basis", "age_s",
                                                         "repeats", "pushback", "corrected",
                                                         "progress", "withhold") if k in detail}
                    told = next((r for r in repairs if detail.get("repair_id") == r["id"]), None)
                    if told is not None:
                        repair = {"id": told["id"], "topic": told["topic"],
                                  "since": told["since"], "basis": "repair"}
                    closed = next((r for r in chapters if detail.get("chapter_id") == r["id"]), None)
                    if closed is not None:
                        chapter = {"id": closed["id"], "topic": closed["topic"],
                                   "opened_at": closed["opened_at"], "closed_at": closed["closed_at"],
                                   "days": closed["days"], "basis": "chapter"}
                except Exception:
                    hint, personhood = "", {}
        if repair and reserve_followup:
            # Said once, on a real turn — the same moment a follow-up reserves its
            # offer; a cancellation puts the record back, so it is not lost.
            data.setdefault("repairs", {})[repair["id"]] = now
            reservation = {"kind": "repair", "id": repair["id"], "at": now}
            # A repair is something that opened in this turn: she jots her own
            # question about it now, to ask days later at a natural moment.
            _author_question(data, topic=repair["topic"], opener="repair",
                             text=_question_for("repair", repair["topic"]), now=now)
            _save(data)
        if chapter and reserve_followup:
            # Told once, like a repair; a cancelled turn puts the record back.
            data.setdefault("chapters", {})[chapter["id"]] = now
            reservation = {"kind": "chapter", "id": chapter["id"], "at": now}
            _save(data)
        style = presence.style_from_memories(active)
        expression = presence.response_plan(conversation_text or "", decision)
        # Only current, relevant corrections; never resurrect a superseded
        # statement just because its correction episode is still in the archive.
        corrections = [e["text"] for e in reversed(data["episodes"])
            if e["kind"] == "correction" and e["status"] == "active"
            and 0 <= now-e["at"] <= 90*86400
            and (generic or terms(e["text"]) & terms(episode_query))
            and any(m["key"] == e.get("source_key") and fold(m["text"]) == fold(e["text"]) for m in active)][:2]
        if corrections:
            selected = list(dict.fromkeys(corrections + selected))[:5]
        return {"memories": selected,
                "continuity": "\n\n".join(part for part in (hint, ledger_page, artifact_page) if part),
                "presence": {**decision, "style": style},
                # Ambient has a much smaller budget: preserve true events and
                # time context ahead of optional conversational nuance.
                "prompt": "\n".join(part for part in (presence.prompt_hint(decision, style),
                    presence.response_hint(expression) if conversation_text is not None else "") if part),
                "expression": expression,
                "ritual_available": ritual_available,
                "corrections": corrections, "personhood": personhood, "repair": repair,
                "chapter": chapter,
                "lens": lens, "artifact": _artifact_view(artifact),
                "repair_ledger": {"requested": ledger is not None,
                                  "complete": (ledger or {}).get("complete_count", 0),
                                  "partial": (ledger or {}).get("partial_count", 0),
                                  "rendered": bool(ledger_page)},
                "selected_episode_count": int(decision["continuity_kind"] == "episode"), "reservation": reservation}


def cancel_context_reservation(packet):
    reservation = packet.get("reservation")
    if not reservation:
        return
    with _lock:
        data = _load()
        if reservation["kind"] == "followup":
            for f in data["followups"]:
                if f["id"] == reservation["id"] and f.get("offered_at") == reservation["at"]:
                    f["offered_at"] = None
                    if reservation.get("self") and f.get("asked_at") == reservation["at"]:
                        # The turn the question was meant for never happened.
                        f.update(status="awaiting_user", asked_at=None)
        elif reservation["kind"] == "repair":
            if (data.get("repairs") or {}).get(reservation["id"]) == reservation["at"]:
                data["repairs"].pop(reservation["id"], None)
        elif reservation["kind"] == "chapter":
            if (data.get("chapters") or {}).get(reservation["id"]) == reservation["at"]:
                data["chapters"].pop(reservation["id"], None)
            # The cooldown the chapter claimed is part of the same reservation:
            # a turn that never carried the line must not spend it either.
            if data["presence"].get("callback_at") == reservation["at"]:
                data["presence"]["callback_at"] = None
        elif data["presence"].get("callback_at") == reservation["at"]:
            data["presence"]["callback_at"] = None
        _save(data)


def snapshot():
    with _lock:
        data = _load()
        now = _now()
        scope = _memory_scope.get()
        return {"ok": True, "shared": True, "revision": data["revision"],
            # Her own questions, open and already asked: the recall view of what she
            # wondered and when she got to ask it.
            "questions": [{k: f.get(k) for k in ("id", "topic", "question", "status", "source",
                                                "opener", "created_at", "not_before", "asked_at",
                                                "ask_count")}
                          for f in data["followups"] if f.get("source") == "self"],
            "lens": lens_select(data, scope, now),
            "artifact": _artifact_view(data.get("artifact")),
            "quiet": quiet_state(data, now),
            "development": growth.derive(data["episodes"], now),
            "episodes": [{k: e[k] for k in ("id", "text", "kind", "at", "evidence")} for e in data["episodes"] if e["status"] == "active"],
            "memories": [{k: m[k] for k in ("id", "kind", "text", "evidence", "created_at", "updated_at")}
                         for m in data["memories"] if m["status"] in ("active", "pending_confirmation") and (m.get("expires_at") is None or m["expires_at"] > now)],
            "followups": [{k: f[k] for k in ("id", "topic", "question", "status", "ask_count")} for f in data["followups"] if f["status"].startswith("awaiting")]}


def validate_personality(traits, *, enforce_budget: bool = True):
    if not isinstance(traits, dict) or set(traits) - set(presence.TRAIT_LABELS):
        raise ValueError("Traits de personnalité invalides")
    if any(not isinstance(v, str) or not v.strip() or len(v.encode("utf-8")) > (320 if k.startswith("ambient_") else 2400)
           for k, v in traits.items()):
        raise ValueError("Trait vide ou trop long (320 octets en ambiance, 2400 par trait)")
    full = {**presence.character_defaults(_memory_scope.get()), **traits}
    # The budget is enforced when saving. Reading a profile that already existed
    # before the sixth trait must stay possible: otherwise a near-cap profile
    # would make the whole companion memory unreadable after the upgrade.
    if enforce_budget and sum(len(full[k].encode("utf-8")) for k in ("humor", "curiosity", "pastimes", "strength", "signature", "flirt")) > 4200:
        raise ValueError("Personnalité trop longue : maximum 4200 octets hors ambiance")
    return {k: v.strip() for k, v in traits.items()}


def personality_traits():
    with _lock:
        return dict(_load().get("personality", {}))


def personality_snapshot():
    with _lock:
        data = _load()
        defaults = presence.character_defaults(_memory_scope.get())
        return {"ok": True, "shared": True, "revision": data.get("personality_revision", 0), "defaults": defaults,
                "traits": {**defaults, **data.get("personality", {})}, "labels": presence.TRAIT_LABELS,
                "customized": sorted(data.get("personality", {}))}


def save_personality(traits, revision, *, reset=False):
    cleaned = {} if reset else validate_personality(traits)
    with _lock:
        data = _load()
        if type(revision) is not int or revision != data.get("personality_revision", 0):
            raise ValueError("La personnalité a changé sur un autre appareil. Recharge l'éditeur avant d'enregistrer.")
        defaults = presence.character_defaults(_memory_scope.get())
        data["personality"] = {k: v for k, v in cleaned.items() if v != defaults[k]}
        data["personality_revision"] = data.get("personality_revision", 0) + 1
        _save(data)
        return personality_snapshot()


def continuity_allowed():
    with _lock:
        return _load()["presence"].get("repair_until", 0) <= _now()


def forget(memory_id):
    with _lock:
        data = _load()
        for episode in data["episodes"]:
            if episode["id"] == memory_id:
                episode["status"] = "forgotten"
        for m in data["memories"]:
            if m["id"] == memory_id and m["status"] in ("active", "pending_confirmation"):
                m["status"] = "forgotten"
                data["forgotten"][hashlib.sha256(m["key"].encode()).hexdigest()[:24]] = _now()
                for episode in data["episodes"]:
                    if episode.get("source_key") == m["key"]:
                        episode["status"] = "forgotten"
                for f in data["followups"]:
                    if f.get("linked_key") == m["key"]:
                        f.update(status="dropped", updated_at=_now())
        _save(data)
    return snapshot()


def correct(memory_id, text):
    if not isinstance(text, str) or not 1 <= len(text.strip()) <= 500:
        raise ValueError("Correction requise (1 à 500 caractères)")
    with _lock:
        data = _load()
        old = next((m for m in data["memories"] if m["id"] == memory_id and m["status"] in ("active", "pending_confirmation")), None)
        if old is None:
            raise ValueError("Souvenir introuvable")
        old["status"] = "superseded"
        item = {k: old[k] for k in ("kind", "subject", "polarity")}
        extracted = extract(text)
        if old["kind"] == "legacy" and not extracted:
            raise ValueError("Précise une phrase complète, par exemple « Je n'aime pas le café » ou « Retiens que… »")
        if extracted:
            item.update(extracted[0])
        else:
            item["text"] = text.strip()
            item["polarity"] = "unknown"
        _remember(data, item, old["source_device"], _now(), evidence="user_correction")
        _record_episode(data, text, "correction", old["source_device"], item["kind"] + ":" + item["subject"])
        _author_question(data, topic=item["subject"], opener="correction",
                         text=_question_for("correction", item["subject"]), now=_now(),
                         device=old["source_device"])
        for f in data["followups"]:
            if f.get("linked_key") == old["key"]:
                f.update(status="dropped", updated_at=_now())
        _project_followup(data, item, old["source_device"], _now())
        data["forgotten"][hashlib.sha256(old["key"].encode()).hexdigest()[:24]] = _now()
        _save(data)
    return snapshot()


def correct_episode(episode_id, text, revision):
    """Edit journal evidence atomically; preserve the original day, not reinforcement."""
    if not isinstance(text, str):
        raise ValueError("Une déclaration explicite est requise")
    parsed = growth.extract(text)
    if not parsed:
        raise ValueError("Précise une expérience avec son résultat, un intérêt, une raison ou un rituel explicite")
    with _lock:
        data = _load()
        if type(revision) is not int or revision != data["revision"]:
            raise ValueError("Le journal a changé sur un autre appareil; recharge-le avant de corriger")
        old = next((e for e in data["episodes"] if e["id"] == episode_id and e["status"] == "active"), None)
        if old is None or old["kind"] not in {"experience", "interest", "meaning", "ritual", "decision"}:
            raise ValueError("Moment de développement introuvable")
        old["status"] = "superseded"
        # ``at`` keeps the day the episode happened; the correction needs its own
        # stamp, or a repair derived from it could not say since when.
        data["episodes"].append({**old, "id": uuid.uuid4().hex, "status": "active",
            "text": parsed["text"], "kind": parsed["kind"], "topic": parsed["topic"],
            "evidence": "user_correction", "source_key": None, "corrected_at": _now()})
        _author_question(data, topic=parsed["topic"], opener="correction",
                         text=_question_for("correction", parsed["topic"]), now=_now(),
                         device=old["source_device"])
        _save(data)
    return snapshot()


def remember_moments(items, user_text, device):
    """Reuse already validated calendar extraction; never make another API call."""
    with _lock:
        data = _load()
        now = _now()
        for item in items:
            try:
                date = datetime.strptime(item["date"], "%Y-%m-%d")
                topic = str(item["what"]).strip()[:80]
                if not topic or not -1 <= (date.date() - datetime.fromtimestamp(now).date()).days <= 90:
                    continue
            except (KeyError, TypeError, ValueError):
                continue
            subject = fold(topic)
            key = "event:" + subject
            _remember(data, {"kind": "event", "subject": subject, "polarity": "neutral",
                "text": str(user_text)[:400] + " · Date retenue : " + item["date"]}, device, now, evidence="date_extraction")
            record = next(m for m in reversed(data["memories"]) if m["key"] == key and m["status"] == "active")
            record.update(source_text=user_text, expires_at=(date + timedelta(days=8)).timestamp())
            same = [f for f in data["followups"] if f.get("linked_key") == key]
            if same and same[-1].get("event_date") == item["date"]:
                continue
            for f in same:
                if f["status"].startswith("awaiting"):
                    f.update(status="superseded", updated_at=now)
            data["followups"].append({"id": uuid.uuid4().hex, "topic": topic, "linked_key": key,
                "event_date": item["date"], "question": "Comment s'est passé « " + topic + " » (" + item["date"] + ") ?",
                "status": "awaiting_outcome", "created_at": now, "updated_at": now, "source_device": device,
                "not_before": (date + timedelta(days=1, hours=9)).timestamp(), "last_asked_at": None,
                "offered_at": None, "ask_count": 0})
        _save(data)


def close_followup(followup_id):
    with _lock:
        data = _load()
        for f in data["followups"]:
            if f["id"] == followup_id:
                f.update(status="dropped", updated_at=_now())
        _save(data)
    return snapshot()


def note_sister_line(speaker: str, text: str, device: str) -> None:
    """Light episode note from a Master-triggered sister dialogue (current memory_scope)."""
    line = re.sub(r"\s+", " ", str(text or "").strip())[:400]
    who = str(speaker or "").strip().lower()
    # Only a sister, and only inside her own scope: a domain assistant's memory
    # must never receive sister dialogue from whichever scope happens to be open.
    sisters = {a["key"] for a in hq_personas.sisters()}
    if not line or who not in sisters or _memory_scope.get() != who:
        return
    label = hq_personas.get(who)["name"]
    with _lock:
        data = _load()
        _record_episode(data, f"{label} a dit (dialogue sœurs) : {line}", "experience", device, None, topic="sister_dialogue")
        _save(data)


def remember_fact(text, device):
    """Mirror an explicit durable fact into shared owner memory without extra API calls."""
    cleaned = str(text or "").strip()[:500]
    if not cleaned:
        return
    with _lock:
        data = _load()
        now = _now()
        items = extract(cleaned) or [{"kind": "fact", "subject": fold(cleaned)[:120], "polarity": "neutral", "text": cleaned}]
        for item in items:
            _remember(data, item, str(device or ""), now, evidence="explicit_statement")
            _project_followup(data, item, str(device or ""), now)
        _save(data)


def forget_text(query):
    """Forget active shared memories matching query substring (accent/case-insensitive)."""
    q = fold(str(query or "")).strip(" .!?")
    if len(q) < 3:
        return 0
    removed = 0
    with _lock:
        data = _load()
        now = _now()
        for m in data["memories"]:
            if m["status"] in ("active", "pending_confirmation"):
                mt = fold(m.get("text", "")).strip(" .!?")
                if q in mt or (mt and mt in q):
                    m["status"] = "forgotten"
                    data["forgotten"][hashlib.sha256(m["key"].encode()).hexdigest()[:24]] = now
                    removed += 1
                    for episode in data["episodes"]:
                        if episode.get("source_key") == m["key"]:
                            episode["status"] = "forgotten"
                    for f in data["followups"]:
                        if f.get("linked_key") == m["key"]:
                            f.update(status="dropped", updated_at=now)
        if removed:
            _save(data)
    return removed
