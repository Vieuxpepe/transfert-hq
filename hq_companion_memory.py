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

_owner = ContextVar("companion_owner", default="admin")
_memory_scope = ContextVar("companion_memory_scope", default="transferania")
_lock = threading.RLock()
_root = Path(".")
_now = lambda: 0.0


class StoreError(RuntimeError):
    pass


def bind(*, root, now):
    global _root, _now
    _root, _now = Path(root), now


@contextmanager
def memory_scope(name: str):
    """Isolate memory JSON and personality by character: ``transferania`` (default) or ``else``."""
    key = str(name or "").strip().lower()
    if key not in ("transferania", "else"):
        key = "transferania"
    token = _memory_scope.set(key)
    try:
        yield
    finally:
        _memory_scope.reset(token)


def current_owner():
    return _owner.get()


def owner_request(fn):
    @functools.wraps(fn)
    def wrapped(*args, **kwargs):
        owner = kwargs.get("owner_id")
        token = _owner.set(str(owner) if owner is not None else current_owner())
        try:
            return fn(*args, **kwargs)
        finally:
            _owner.reset(token)
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
    if scope == "else":
        base = base / "else"
    return base / (key + ".json")


def _empty():
    return {"v": 1, "revision": 0, "memories": [], "followups": [], "imported": {}, "forgotten": {}, "presence": {}, "episodes": []}


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
        if type(data["personality_revision"]) is not int or data["personality_revision"] < 0:
            raise ValueError("Révision de personnalité invalide")
        validate_personality(data["personality"])
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
            if any(not isinstance(f[k], str) for k in ("id", "topic", "question", "status")) or f["status"] not in {"awaiting_user", "awaiting_outcome", "resolved", "dropped", "superseded"}:
                raise ValueError("État de suivi invalide")
            if not all(finite(f[k]) for k in ("created_at", "updated_at", "not_before", "ask_count")) or any(f.get(k) is not None and not finite(f[k]) for k in ("last_asked_at", "offered_at")):
                raise ValueError("Suivi invalide")
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
    with _lock:
        data = _load()
        for question in questions[-1:]:
            matching = [f for f in data["followups"] if f["status"].startswith("awaiting") and terms(f["topic"]) & terms(question)]
            if matching:
                matching[-1].update(last_asked_at=now, offered_at=now, ask_count=matching[-1]["ask_count"] + 1)
                continue
            items = extract(user_text)
            topic = items[0]["subject"] if items else user_text.strip()
            if len(terms(topic)) < 1 or len(terms(question)) < 2 or not (terms(topic) & terms(question)):
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
    data["episodes"].append({"id": uuid.uuid4().hex, "text": str(text).strip(), "kind": kind,
        "topic": str(topic or (key.partition(":")[2] if key else ""))[:160],
        "source_device": device, "source_key": key, "at": _now(), "evidence": "user_statement", "status": "active"})


def context(query, *, reserve_followup=False):
    packet = context_packet(query, reserve_followup=reserve_followup)
    return packet["memories"], packet["continuity"]


def context_packet(query, *, reserve_followup=False, conversation_text=None, allow_followup=True):
    with _lock:
        data = _load()
        now = _now()
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
        followup = due[0] if due else None
        state = data["presence"]
        mode = presence.classify(conversation_text) if conversation_text is not None else state.get("mode", "social") if now - state.get("at", 0) < 1800 else "social"
        recall = mode == "recall"
        episode_query = conversation_text if conversation_text is not None else query
        episodes = [e for e in data["episodes"] if e["status"] == "active" and now - e["at"] <= 90 * 86400]
        scored = [(len(terms(episode_query) & terms(e["text"] + " " + e.get("topic", ""))), e["at"], e) for e in episodes]
        scored.sort(key=lambda r: (r[0], r[1]), reverse=True)
        generic_recall = recall and bool(re.search(r"what do you remember|last time|dernier.*(?:fois|moment)|de quoi.*souviens", fold(episode_query)))
        episode = next((e for relevance, _, e in scored if relevance or generic_recall), None)
        callback_cooled = state.get("callback_at") is None or now - state["callback_at"] >= 21600
        callback_ready = state.get("return_gap", 0) >= 21600 and callback_cooled
        # Let a reinforced interest or an explicitly named ritual colour a
        # relevant social exchange without requiring a memory quiz or a return.
        # It still shares the one continuity slot and six-hour cooldown.
        motif = growth.natural_callback(views, episode_query, terms=terms) if not requested and mode == "social" and callback_cooled else None
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
            reservation = {"kind": "followup", "id": followup["id"], "at": now}
            _save(data)
        hint = ""
        ritual_available = bool(view and view["kind"] == "ritual")
        if decision["continuity_kind"] == "followup":
            hint = "SUJET EN ATTENTE (une seule relance si le moment convient, sans inventer de résultat) : " + followup["question"]
            reason = growth.meaning_for(views, followup["topic"], terms=terms)
            if reason:
                hint += "\n" + reason
        elif decision["continuity_kind"] == "episode":
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
        return {"memories": selected, "continuity": hint, "presence": {**decision, "style": style},
                # Ambient has a much smaller budget: preserve true events and
                # time context ahead of optional conversational nuance.
                "prompt": "\n".join(part for part in (presence.prompt_hint(decision, style),
                    presence.response_hint(expression) if conversation_text is not None else "") if part),
                "expression": expression,
                "ritual_available": ritual_available,
                "corrections": corrections,
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
        elif data["presence"].get("callback_at") == reservation["at"]:
            data["presence"]["callback_at"] = None
        _save(data)


def snapshot():
    with _lock:
        data = _load()
        now = _now()
        return {"ok": True, "shared": True, "revision": data["revision"],
            "development": growth.derive(data["episodes"], now),
            "episodes": [{k: e[k] for k in ("id", "text", "kind", "at", "evidence")} for e in data["episodes"] if e["status"] == "active"],
            "memories": [{k: m[k] for k in ("id", "kind", "text", "evidence", "created_at", "updated_at")}
                         for m in data["memories"] if m["status"] in ("active", "pending_confirmation") and (m.get("expires_at") is None or m["expires_at"] > now)],
            "followups": [{k: f[k] for k in ("id", "topic", "question", "status", "ask_count")} for f in data["followups"] if f["status"].startswith("awaiting")]}


def validate_personality(traits):
    if not isinstance(traits, dict) or set(traits) - set(presence.TRAIT_LABELS):
        raise ValueError("Traits de personnalité invalides")
    if any(not isinstance(v, str) or not v.strip() or len(v.encode("utf-8")) > (320 if k.startswith("ambient_") else 2400)
           for k, v in traits.items()):
        raise ValueError("Trait vide ou trop long (320 octets en ambiance, 2400 par trait)")
    full = {**presence.character_defaults(), **traits}
    if sum(len(full[k].encode("utf-8")) for k in ("humor", "curiosity", "strength", "signature", "flirt")) > 4200:
        raise ValueError("Personnalité trop longue : maximum 4200 octets hors ambiance")
    return {k: v.strip() for k, v in traits.items()}


def personality_traits():
    with _lock:
        return dict(_load().get("personality", {}))


def personality_snapshot():
    with _lock:
        data = _load()
        defaults = presence.character_defaults()
        return {"ok": True, "shared": True, "revision": data.get("personality_revision", 0), "defaults": defaults,
                "traits": {**defaults, **data.get("personality", {})}, "labels": presence.TRAIT_LABELS,
                "customized": sorted(data.get("personality", {}))}


def save_personality(traits, revision, *, reset=False):
    cleaned = {} if reset else validate_personality(traits)
    with _lock:
        data = _load()
        if type(revision) is not int or revision != data.get("personality_revision", 0):
            raise ValueError("La personnalité a changé sur un autre appareil. Recharge l'éditeur avant d'enregistrer.")
        defaults = presence.character_defaults()
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
        data["episodes"].append({**old, "id": uuid.uuid4().hex, "status": "active",
            "text": parsed["text"], "kind": parsed["kind"], "topic": parsed["topic"],
            "evidence": "user_correction", "source_key": None})
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
    if not line or who not in ("transferania", "else"):
        return
    label = "Transferania" if who == "transferania" else "Else"
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
