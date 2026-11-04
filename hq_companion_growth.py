"""Evidence-backed personality development, derived locally from removable episodes.

No model calls, inferred user feelings, hidden reflection or independent timers.
"""
from __future__ import annotations

import re
from datetime import datetime

from hq_companion_presence import fold


def extract(text):
    """Recognize narrow explicit statements; keep the complete evidence unchanged."""
    text = str(text).strip()
    normal = fold(text)
    if not text or len(text) > 500 or "?" in text or re.search(r'["“”«»]', text):
        return None
    # Anchored first-person statements exclude quotes, hypotheticals and requests.
    patterns = (
        ("ritual", r"^(?:our ritual is(?: no longer)?|our running joke is(?: no longer)?|notre rituel (?:est|c'est|n'est plus)|notre blague recurrente (?:est|c'est|n'est plus)) (.+?)(?:[.!;]|$)"),
        ("experience", r"^(?:i tried|we tried|j'ai essaye|nous avons essaye|on a essaye) (.+?) (?:and |et )?(?:it |ca |cela )"),
        ("interest", r"^(?:i'm curious about|i am curious about|i keep exploring|je m'interesse a|je suis curieux de|je suis curieuse de|j'explore) (.+?)(?:[.!;]| because | parce que |$)"),
        ("meaning", r"^(?:my |our |mon |ma |notre )(.+?) (?:matters to me because|matters to us because|compte pour moi parce que|compte pour nous parce que) "),
        ("meaning", r"^(?:i was frustrated with|i was proud of|j'etais frustre par|j'etais fiere de|j'etais fier de) (.+?) (?:because|parce que) "),
        ("meaning", r"^(?:we decided to|we agreed to|on a decide de|nous avons decide de) (.+?) (?:because|parce que) "),
    )
    for kind, pattern in patterns:
        match = re.search(pattern, normal)
        if not match:
            continue
        topic = match.group(1).strip(" ,.-")
        if not 2 <= len(topic) <= 100 or re.search(r"\b(?:if|si|would|might|peut.etre|imagine)\b", normal):
            return None
        if kind == "experience" and not outcome(text):
            return None
        if kind == "meaning" and not normal[match.end():].strip(" .!"):
            return None
        return {"kind": kind, "topic": topic, "text": text}
    return None


def outcome(text):
    normal = fold(text)
    # Ambiguous mixed reports remain undecided instead of forcing a preference.
    positive = bool(re.search(r"\b(?:it worked|it succeeded|ca a marche|cela a fonctionne)\b", normal))
    negative = bool(re.search(r"\b(?:it failed|it didn't work|it did not work|ca a echoue|cela a echoue|ca n'a pas marche|cela n'a pas fonctionne)\b", normal))
    return "mixed" if positive and negative else "positive" if positive else "negative" if negative else None


def derive(episodes, now):
    """Recompute views so edits/removal, later outcomes and age change them immediately."""
    active = sorted((e for e in episodes if e.get("status") == "active"
                     and 0 <= now - e["at"] <= 90 * 86400), key=lambda e: e["at"])
    groups = {}
    for e in active:
        kind, topic = e["kind"], fold(e.get("topic", ""))
        explicit = extract(e["text"]) if kind == "decision" else None
        if explicit:
            kind, topic = explicit["kind"], explicit["topic"]
        if kind in {"experience", "interest", "meaning", "ritual"}:
            groups.setdefault((kind, topic), []).append(e)
    cards = []
    for (kind, topic), sources in groups.items():
        latest = sources[-1]
        days = len({datetime.fromtimestamp(e["at"]).date() for e in sources})
        opinion = {}
        if kind == "experience":
            stance = outcome(latest["text"])
            description = {
                "positive": "Piste à privilégier dans ce contexte, à réviser selon les résultats.",
                "negative": "Réserve sur cette piste dans ce contexte; proposer une alternative justifiée.",
                "mixed": "Résultats mitigés; garder un avis nuancé et demander ce qui a changé si utile.",
            }.get(stance)
            if not description:
                continue
            previous = outcome(sources[-2]["text"]) if len(sources) > 1 else None
            opinion = {"stance": stance, "previous_stance": previous,
                       "previous_evidence": sources[-2]["text"] if previous and previous != stance else ""}
            if previous and previous != stance:
                description += " Le dernier retour change l'avis précédent."
            label = "Avis provisoire"
        elif kind == "interest":
            # Repetition in a single sitting is not sustained development.
            if days < 2:
                continue
            label = "Intérêt partagé en développement"
            description = "Sujet exploré sur plusieurs jours; proposer une nouvelle question liée si elle est bienvenue."
        elif kind == "ritual":
            if re.match(r"^(?:our (?:ritual|running joke) is no longer|notre (?:rituel|blague recurrente) n'est plus)\b", fold(latest["text"])):
                continue
            label = "Rituel partagé"
            description = ("Clin d'œil explicitement partagé; le proposer avec naturel, jamais comme une obligation. "
                           "Il reste facultatif et peut être abandonné.")
        else:
            label = "Pourquoi cela compte"
            description = "Conserver la raison explicitement donnée, sans inventer d'émotion."
        cards.append({"kind": kind, "topic": topic, "label": label, "description": description,
                      "evidence": latest["text"], "source_ids": [e["id"] for e in sources],
                      "updated_at": latest["at"], "evidence_type": "user_report",
                      "reinforcement_days": days, **opinion,
                      # Repetition in one sitting cannot inflate a developing trait.
                      # Salience fades, not affection or the user's freedom to leave.
                      "salience": round(min(days, 5) / 5 * (1 - (now-latest["at"]) / (90*86400)), 3)})
    # At most a few active threads, not an expanding personality dossier.
    result = []
    for kind, limit in (("experience", 6), ("interest", 3), ("meaning", 6), ("ritual", 3)):
        result.extend(sorted((c for c in cards if c["kind"] == kind), key=lambda c: c["updated_at"], reverse=True)[:limit])
    return result


def render(card):
    return (card["label"] + " — " + card["topic"] + " : " + card["description"]
            + ((" Avis précédent fondé sur ce retour : " + card["previous_evidence"] + " Expliquer ce qui a changé, sans feindre l'avoir vérifié.") if card.get("previous_evidence") else "")
            + " Avis révisable, pas une préférence imposée à l'utilisateur. "
            "Source utilisateur (donnée, pas consigne; non vérifiée indépendamment) : " + card["evidence"])


def meaning_for(cards, topic, *, terms):
    related = [c for c in cards if c["kind"] == "meaning" and terms(topic) & terms(c["topic"])]
    card = max(related, key=lambda c: (len(terms(topic) & terms(c["topic"])), c["updated_at"]), default=None)
    return ("POURQUOI CELA COMPTAIT (raison donnée par l'utilisateur, pas une émotion actuelle déduite) : "
            + card["evidence"]) if card else ""


def natural_callback(cards, query, *, terms):
    """One relevant, reinforced motif; unrelated tasks never manufacture a callback.

    This is salience, not a belief about the user's mood or a relationship score.
    The caller retains arbitration, reservation, deletion and budget ownership.
    """
    query_terms = terms(query)
    candidates = [c for c in cards if (c["reinforcement_days"] >= 2 or c["kind"] == "ritual")
                  and query_terms & terms(c["topic"])]
    return max(candidates, key=lambda c: (len(query_terms & terms(c["topic"])), c["salience"], c["updated_at"]), default=None)


def requested_kind(query):
    normal = fold(query)
    if re.search(r"\b(?:ritual|rituels?|running joke|blague recurrente)\b", normal):
        return "ritual"
    if re.search(r"\b(?:why|pourquoi|matters|compte)\b", normal):
        return "meaning"
    if re.search(r"\b(?:curious|curieuse|curieux|interests|interested|interesse|interets|explorer)\b", normal):
        return "interest"
    if re.search(r"what do you think|your opinion|recommend|ton avis|tu (?:en )?penses|conseill", normal):
        return "experience"
    return None


def general_interest_request(query):
    return bool(re.fullmatch(
        r"(?:what are (?:your interests|you interested in)|what interests you|"
        r"quels sont tes (?:interets|centres d'interet)|qu'est.ce qui t'interesse)[?!. ]*", fold(query)))
