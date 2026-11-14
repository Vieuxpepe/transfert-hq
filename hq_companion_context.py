"""Pure, bounded companion context selection. No stores, network calls or prompts in logs."""
from __future__ import annotations

import re
import unicodedata
from collections import Counter


def normalize(text):
    return re.sub(r"\s+", " ", str(text)).strip()


def _stem(word):
    for suf in ("ements", "ement", "ations", "ation", "ures", "ure", "euses", "euse", "eurs", "eur",
                "ieres", "iere", "istes", "iste", "ables", "able", "ent", "ant", "ais", "ait",
                "ir", "er", "re", "es", "s", "ing", "ed", "ly"):
        if word.endswith(suf) and len(word) - len(suf) >= 4:
            return word[:-len(suf)]
    return word


def terms(text):
    text = re.sub(r"\bthé\b", "teadrink", str(text), flags=re.I)
    text = "".join(c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c))
    stop = set("je tu il elle le la les de du des un une mon ma mes ton ta tes nous vous on et pour avec dans que est pas sur the a an i you my your we our to and is it in for of what how why can do did about please this that actually decided need finish finished use because".split())
    out = set()
    for word in set(re.findall(r"[a-z0-9]{3,}", text)) - stop:
        mapped = {"coffee": "cafe", "tea": "teadrink"}.get(word, word)
        out.add(mapped)
        out.add(_stem(mapped))
    return out


def page_kind(text):
    """Only server formatter prefixes classify a block, never words inside its body."""
    head = text.splitlines()[0].strip() if text.strip() else ""
    for prefix, kind in (("ÉVÉNEMENT RÉEL", "event"), ("À DEMANDER", "event"),
                         ("DONNÉES HQ EN DIRECT", "event"),
                         ("SUJET PARTAGÉ", "followthrough"), ("POURQUOI CELA COMPTAIT", "followthrough"),
                         ("SŒUR PRÉSENTE", "sister"),
                         ("Action réussie à l'instant", "event"), ("Échec ou erreur récente", "behavior"),
                         ("TEMPS (vrai)", "time"), ("PRÉSENCE", "behavior"), ("NUANCE DE RÉPONSE", "behavior"),
                         ("DÉJÀ DIT", "behavior"), ("ÉTAT INTERNE", "behavior"),
                         ("RÉGIME", "behavior"),
                         ("VOIX TRANSFERANIA", "delivery"), ("VOIX ELSE", "delivery"),
                         ("TOUCHE FACULTATIVE", "quirk"),
                         ("SUJET EN ATTENTE", "continuity"), ("ÉPISODE ÉNONCÉ", "continuity"),
                         ("Rituel partagé", "continuity"), ("Avis provisoire", "continuity"),
                         # Her own personhood lines: identity content, not page chrome.
                         ("FIL RÉCENT AVEC", "personhood"), ("FIL ANCIEN AVEC", "personhood"),
                         ("POINT À ÉCLAIRCIR", "personhood"), ("POINT ANCIEN À ÉCLAIRCIR", "personhood"),
                         ("VISITE RÉCENTE AVEC", "personhood"), ("VISITE ANCIENNE AVEC", "personhood"),
                         ("SUJET RÉCENT", "personhood"), ("SUJET ANCIEN", "personhood"),
                         ("NOTE SUR MOI", "personhood"),
                         ("VALEUR APPRISE", "personhood")):
        if head.startswith(prefix):
            return kind
    return "page"


PRIORITY = {"correction": 100, "personhood": 96, "event": 95, "followthrough": 92, "sister": 91, "time": 90,
            "behavior": 88, "memory": 85, "summary": 80, "history_recent": 76, "page": 70,
            "continuity": 68, "history_relevant": 65,
            "delivery": 30, "quirk": 20}
HEADINGS = {"summary": "RÉSUMÉ", "memory": "SOUVENIR PERTINENT", "correction": "CORRECTION"}
# A fixed share of the input budget belongs to the blocks that carry her
# personhood: an explicit correction and her own lines. Optional context may
# never spend it, so growth elsewhere cannot squeeze them out of the packet.
PROTECTED_KINDS = ("correction", "personhood")
PROTECTED_SHARE = 0.15
PAGE_PREFIX = "CONTEXTE ACTUEL:\n"


def block_cost(candidate, *, page_prefix=True):
    """Bytes one candidate adds to the payload, in the estimator's own frame."""
    text, kind = candidate["text"], candidate["kind"]
    if "group" in candidate:
        return 32 + sum(len(p["text"].encode()) for m in candidate["group"] for p in m["parts"])
    if kind in HEADINGS:
        return len((HEADINGS[kind] + ":\n" + text).encode()) + 2
    return len(text.encode()) + 2 + (len(PAGE_PREFIX.encode()) if page_prefix else 0)


def assemble(system, message, *, budget, groups, summary="", memories=(), corrections=(), page="",
             personhood=None):
    """Select whole blocks/pairs by priority; serialize history chronologically.

    Costs use the same conservative UTF-8-plus-message-overhead estimator as
    hq_ai. The manifest uses fixed kind/index IDs, sizes and reasons only.

    The blocks that carry her personhood — an explicit correction, then her own
    lines — are reserved before anything optional is considered: a bounded share
    of the budget is charged up front and they are admitted by rule inside it,
    so no other block can take that room and growth elsewhere cannot squeeze
    them out. The share never exceeds what those blocks actually need, and it is
    withdrawn (never overspent) when the mandatory core leaves no room.

    ``personhood`` carries the salience of her own line (tier, priority and
    byte share) derived from the evidence behind it: a subject that is recent
    and repeated ranks higher and may take more bytes, while a stale one ranks
    lower in its own band and keeps a smaller share — still carried, as a dated
    trace, rather than dropped. Only a line longer than that share is refused.
    """
    base = 48 + len(system.encode()) + len(message.encode())
    if base > budget:
        raise ValueError("mandatory_context_too_large")
    manifest = [dict(id="system", kind="system", estimated_bytes=len(system.encode()), selected=True, reason="mandatory", priority=110),
                dict(id="current_message", kind="current_message", estimated_bytes=len(message.encode()), selected=True, reason="mandatory", priority=110)]
    candidates = []
    def add(kind, text, **extra):
        if str(text).strip():
            candidates.append(dict(kind=kind, text=str(text).strip(), order=len(candidates), **extra))
    for text in list(corrections)[:2]:
        add("correction", text)
    correction_keys = {normalize(t) for t in corrections}
    remaining = 5 - min(2, len(corrections))
    for text in [str(t) for t in memories if normalize(t) not in correction_keys][:remaining]:
        add("memory", text)
    add("summary", summary)
    for block in re.split(r"\n\s*\n", str(page)):
        add(page_kind(block.strip()), block)
    query = terms(message)
    for index, group in enumerate(groups):
        relevance = len(query & terms(group[0]["parts"][0]["text"]))
        kind = "history_recent" if index >= len(groups)-2 else "history_relevant"
        text = "\n".join(p["text"] for m in group for p in m["parts"])
        add(kind, text, group=group, history_index=index, relevance=relevance)
    salience = personhood if isinstance(personhood, dict) else {}
    personhood_priority = int(salience.get("priority") or PRIORITY["personhood"])
    personhood_share = int(salience.get("share") or 0)
    for c in candidates:
        if c["kind"] == "personhood":
            c["priority"] = personhood_priority
            if salience.get("rung"):
                # The manifest says which rung she is on, not a base tier she is not.
                c["rung"] = str(salience["rung"])
            if personhood_share and block_cost(c) > personhood_share:
                # Her declared share is smaller than her own line: this state may
                # not occupy the packet. The bands are sized so a normal hint
                # always fits; only a longer line is refused here.
                c["over_share"] = personhood_share
    ranked = sorted(candidates, key=lambda c: (-c.get("priority", PRIORITY[c["kind"]]),
        -c.get("relevance", 0) if c["kind"] == "history_relevant" else 0,
        -c.get("history_index", 0), c["order"]))
    # The share is a ceiling on what may be set aside, never a tax: only bytes
    # that actually carry a protected block are charged, so optional content
    # keeps whatever no personhood line will spend.
    share_room = min(int(budget * PROTECTED_SHARE), max(0, budget - base))
    reserved, guaranteed = 0, set()
    for c in ranked:
        if c["kind"] in PROTECTED_KINDS and not c.get("over_share"):
            cost = block_cost(c)
            if reserved + cost <= share_room:
                guaranteed.add(c["order"])
                reserved += cost
    # Charged before anything optional is considered, so no other block can take
    # that room: optional candidates only see what is left after the share.
    used, page_selected = base + reserved, False
    selected, seen = [], {normalize(message), normalize(system)}
    seen.update(normalize(b) for b in re.split(r"\n\s*\n", system))
    for c in ranked:
        kind, text = c["kind"], c["text"]
        history = "group" in c
        row = dict(id=f"{kind}.{c['order']}", kind=kind, estimated_bytes=len(text.encode()),
                   selected=False, reason="budget", priority=c.get("priority", PRIORITY[kind]))
        if kind == "personhood":
            if personhood_share:
                row["share"] = personhood_share
            if c.get("rung"):
                row["rung"] = c["rung"]
        if history:
            row["history_index"] = c["history_index"]
        cost = block_cost(c, page_prefix=not page_selected)
        if history and kind == "history_relevant" and not c["relevance"]:
            row["reason"] = "irrelevant"
        elif not history and normalize(text) in seen:
            row["reason"] = "duplicate"
            if c["order"] in guaranteed:
                used -= cost  # release a reservation nothing will spend
        elif c.get("over_share"):
            # Refused on her own byte share, whatever room the budget has left.
            row["reason"] = "budget"
        elif c["order"] in guaranteed:
            # Already paid for by the reserved share; never re-checked against
            # the remaining room, so optional content cannot displace it.
            row.update(selected=True, reason="included")
            selected.append(c)
            seen.add(normalize(text))
            if kind not in HEADINGS:
                page_selected = True
        elif used + cost <= budget:
            row.update(selected=True, reason="included")
            used += cost
            selected.append(c)
            if not history:
                seen.add(normalize(text))
                if kind not in HEADINGS:
                    page_selected = True
        manifest.append(row)
    # Selection order is priority-based; preserve original page ordering and
    # paired history chronology in the actual payload.
    extras, pages = [], []
    for c in sorted((c for c in selected if "group" not in c), key=lambda c: c["order"]):
        if c["kind"] in HEADINGS:
            extras.append(HEADINGS[c["kind"]]+":\n"+c["text"])
        else:
            pages.append(c["text"])
    if pages:
        extras.append("CONTEXTE ACTUEL:\n"+"\n\n".join(pages))
    contents = [m for c in sorted((c for c in selected if "group" in c), key=lambda c: c["history_index"]) for m in c["group"]]
    contents.append({"role": "user", "parts": [{"text": "\n\n".join(extras+[message])}]})
    return contents, {"selection_manifest": manifest[:200], "manifest_omitted_count": max(0, len(manifest)-200),
        "selection_totals": dict(Counter(row["reason"] for row in manifest)),
        "selected_memory_count": sum(c["kind"] in {"memory", "correction"} for c in selected),
        "selected_history_count": sum(2 for c in selected if "group" in c)}


def decision_summary(old_summary, chunk, *, limit, extract):
    """Source-labelled decisions, reasons and open/closed threads; no invented facts."""
    records = []
    def record(text, role, replaced=False):
        text = normalize(text)
        if not text or len(text) > 650:
            return
        user = role == "user"
        parsed = extract(text) if user else []
        key = next((p["kind"]+":"+p["subject"] for p in parsed if p["kind"] in {"preference", "fact", "project"}), None)
        n = text.lower().replace("’", "'")
        if user and re.search(r"correction|actually|en fait|plutôt|instead|rather|n'aime pas|don't like", n):
            kind, priority = "Correction", 100
        elif user and re.search(r"we (?:decided|agreed)|on a décidé|nous avons décidé|j'ai choisi|i chose|decision", n):
            kind, priority = "Décision", 90
        elif user and re.search(r"^(?:i finished|it's done|j'ai fini|c'est (?:fait|terminé))\b", n):
            kind, priority = "Résolu", 85
        elif "?" in text or (user and re.search(r"still need|reste à|en attente|à faire|i need|je dois", n)):
            kind, priority = "Ouvert", 70 if user else 40
        elif parsed:
            kind, priority = "Préférence" if parsed[0]["kind"] == "preference" else "Repère", 75
        else:
            historical = role == "historical"
            kind, priority = "Repère" if user or historical else "Dialogue", 15 if user or historical else 5
        if replaced:
            kind, priority = "Remplacé", 10
        topic = terms(text)
        for previous in records:
            same_key = key and previous["key"] == key
            closing = kind == "Résolu" and previous["kind"] == "Ouvert" and bool(previous["topic"]) and previous["topic"] <= topic
            revising = kind == "Correction" and previous["kind"] == "Décision" and len(topic & previous["topic"]) >= 2
            if not replaced and (closing or (previous["role"] == "user" and (same_key or revising))) and previous["text"] != text:
                previous.update(kind="Remplacé", priority=10)
        records.append(dict(text=text, role=role, kind=kind, priority=priority, topic=topic, key=key))
    for line in str(old_summary or "").splitlines():
        # Preserve legacy evidence as historical text, never elevate a model's
        # earlier summary into a new user statement.
        match = re.match(r"(Correction|Décision|Résolu|Ouvert|Préférence|Repère|Dialogue|Remplacé) — (User|Transferania|Historique): (.*)", line)
        if match:
            record(match[3], "user" if match[2] == "User" else "assistant" if match[2] == "Transferania" else "historical",
                   replaced=match[1] == "Remplacé")
        else:
            record(line, "historical")
    for message in chunk:
        if isinstance(message, dict) and message.get("role") in {"user", "assistant"}:
            text = str(message.get("text") or "")
            # Keep a short decision and its following reason together.
            sentences = [text] if len(normalize(text)) <= 650 else re.split(r"(?<=[.!?])\s+|\n+", text)
            for sentence in sentences:
                record(sentence, message["role"])
    chosen, seen, used = [], set(), 0
    for index in sorted(range(len(records)), key=lambda i: (-records[i]["priority"], -i)):
        r = records[index]
        who = "User" if r["role"] == "user" else "Transferania" if r["role"] == "assistant" else "Historique"
        line = f"{r['kind']} — {who}: {r['text']}"
        if normalize(r["text"]) not in seen and used+len(line)+1 <= limit:
            chosen.append((index, line))
            seen.add(normalize(r["text"]))
            used += len(line)+1
    return "\n".join(line for _, line in sorted(chosen))
