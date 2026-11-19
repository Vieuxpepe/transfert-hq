"""Deterministic reply guard for the companion chat.

The voice and shape cues only ask the model for a given delivery; a live model
still slips. This module is the enforcement layer: before a reply is stored,
returned, spoken or shown, it checks two hard rules and repairs the text in
place, without another provider call.

* The reply never opens on a French article/determiner (un, une, des, le, la,
  les, l', du, de, d') and never opens on a bare noun fragment. A compliant
  interjection ("Oui.", "Tiens!", "D'accord.") is not a fragment.
* The reply never volunteers a clock or time-of-day reference. When the Master
  himself mentions the hour or the moment, the reference is his and is allowed.

Repairs are pure text edits: a rotating reaction particle in front of a
forbidden opening, and removal of the clause that carried a volunteered time
reference (never the whole reply unless nothing else is left).
"""
from __future__ import annotations

import re
import unicodedata
import zlib
from typing import Any

# Interjections are complete short replies, not noun fragments.
INTERJECTIONS = frozenset({
    "oui", "non", "si", "ah", "oh", "eh", "he", "hein", "bon", "ben", "bah",
    "tiens", "voila", "salut", "bonjour", "bonsoir", "coucou", "merci",
    "bravo", "pardon", "ok", "okay", "ouais", "mouais", "bof", "mince", "zut",
    "d'accord", "daccord", "entendu", "exact", "voilà", "hep", "hola",
})

_PARTICLES = ("Tiens", "Ah", "Hé", "Bon", "Oh", "Écoute", "Tu sais")

_ARTICLE_OPEN = re.compile(
    r"^\s*(?:(?:un|une|des|les?|la|du|de)(?=[\s,.;:!?…]|$)|[dl]['’])",
    re.IGNORECASE,
)

# Clock and time-of-day. Bare "soir"/"matin" count too: volunteering them is the
# tic this guard exists for. "aujourd'hui", a weekday or a date is not a clock.
_TIME = re.compile(
    r"(?:\bmidi\b|\bminuit\b"
    r"|\b(?:[01]?\d|2[0-3])\s?h(?:\s?\d{2})?\b"
    r"|\b(?:[01]?\d|2[0-3])\s?heures?\b"
    r"|\bune heure(?: de midi)?\b"
    r"|\b(?:ce|cet|cette)\s+(?:matin|après-midi|apres-midi|soir|nuit)\b"
    r"|\bl['’]après-midi\b|\bl['’]apres-midi\b"
    r"|\b(?:le|du|au)\s+matin\b|\b(?:le|du)\s+soir\b|\ben soirée\b"
    r"|\bla matinée\b|\bla soirée\b)",
    re.IGNORECASE,
)
_TIME_HINT = re.compile(
    r"(?:\bheures?\b|\bmatin\b|\bsoir\b|\bnuit\b|\bmidi\b|\bminuit\b"
    r"|\baprès-midi\b|\bapres-midi\b|\b[01]?\d\s?h\b|\bjournée\b)",
    re.IGNORECASE,
)

# A greeting names the moment without talking about it: it does not license the
# reply to volunteer the clock ("Bonne nuit" must not allow "plein midi dehors").
_GREETING_TIME = re.compile(r"\bbonne\s+(?:nuit|journée|journee|soirée|soiree)\b", re.IGNORECASE)

# Deictic time talk: no number is named, the hour still is.
_TIME_DEICTIC = re.compile(
    r"(?:(?:\b(?:à|a)\s+)?\bcette heure(?:-ci)?\b|(?:\ba|\bà)\s+l[’']heure\b|\bl[’']heure\b|\bdes heures\b)",
    re.IGNORECASE,
)
# Hours said in words, and day-period idioms that name the moment.
_TIME_SPOKEN = re.compile(
    r"(?:\b(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix[- ]sept|dix[- ]huit|dix[- ]neuf|vingt(?:[- ](?:et[- ]une|deux|trois))?)\s+heures?\b(?!\s+de\s+(?:route|travail|pause|sommeil|vol|train|attente|marche|cours)\b)|\bmilieu du jour\b|\bplein jour\b|\b(?:matin|après-midi|apres-midi|après midi|apres midi)\b)",
    re.IGNORECASE,
)
_SENTENCE = re.compile(r"(?<=[.!?…])(\s+)")
_CLAUSE = re.compile(r"(?<=[,;])\s+|\s+et\s+")


def fold(text: Any) -> str:
    plain = unicodedata.normalize("NFKD", str(text or ""))
    return plain.encode("ascii", "ignore").decode().lower()


def _first_token(text: str) -> str:
    match = re.match(r"\s*([^\s,.;:!?…]+)", text)
    return match.group(1) if match else ""


def opens_on_article(text: str) -> bool:
    """True when the first word is a French article/determiner."""
    if not _first_token(text) or fold(_first_token(text)) in INTERJECTIONS:
        return False
    return bool(_ARTICLE_OPEN.match(text))


def opens_on_fragment(text: str) -> bool:
    """True when the reply opens on a single noun-like word standing alone."""
    stripped = str(text or "").lstrip()
    if not stripped:
        return False
    sentence = re.split(r"(?<=[.!?…])\s", stripped, maxsplit=1)[0]
    words = re.findall(r"[0-9A-Za-zÀ-ÖØ-öø-ÿ'’-]+", sentence)
    if len(words) != 1:
        return False
    return fold(words[0]) not in INTERJECTIONS


def mentions_time(text: str) -> bool:
    raw = str(text or "")
    return bool(_TIME.search(raw) or _TIME_DEICTIC.search(raw) or _TIME_SPOKEN.search(raw))


_CLOCK = re.compile(
    r"(?:\bmidi\b|\bminuit\b|\b(?:[01]?\d|2[0-3])\s?h(?:\s?\d{2})?\b|\b(?:[01]?\d|2[0-3])\s?heures?\b|\b(?:une|deux|trois|quatre|cinq|six|sept|huit|neuf|dix|onze|douze|treize|quatorze|quinze|seize|dix[- ]sept|dix[- ]huit|dix[- ]neuf|vingt(?:[- ](?:et[- ]une|deux|trois))?)\s+heures?\b)",
    re.IGNORECASE,
)

_ASKS_HOUR = re.compile(r"quelle heure|what time|what's the time", re.IGNORECASE)


def _time_spans(text: str) -> list[str]:
    raw = str(text or "")
    found: list[tuple[int, int]] = []
    candidates = [match.span() for pattern in (_TIME, _TIME_DEICTIC, _TIME_SPOKEN)
                  for match in pattern.finditer(raw)]
    # Longest span first: "après-midi" must win over the bare "midi" inside it.
    for start, end in sorted(candidates, key=lambda span: span[0] - span[1]):
        if not any(start < other_end and end > other_start for other_start, other_end in found):
            found.append((start, end))
    return [raw[start:end] for start, end in sorted(found)]


def user_allows_time(user_text: str) -> bool:
    """The Master asked the hour or stated one himself: that reference is his."""
    raw = _GREETING_TIME.sub(" ", str(user_text or ""))
    return bool(_ASKS_HOUR.search(raw) or _CLOCK.search(raw))


def volunteered_time(text: str, user_text: str = "") -> list[str]:
    """Time spans in the reply that the Master did not put there himself."""
    if not mentions_time(text) or user_allows_time(user_text):
        return []
    said = fold(_GREETING_TIME.sub(" ", str(user_text or "")))
    return [span for span in _time_spans(text) if fold(span) not in said]


def opening_violation(text: str) -> str:
    if opens_on_article(text):
        return "article"
    if opens_on_fragment(text):
        return "fragment"
    return ""


def _capitalise(text: str) -> str:
    for index, char in enumerate(text):
        if char.isalpha():
            return text[:index] + char.upper() + text[index + 1:]
    return text


def _lower_first(text: str) -> str:
    for index, char in enumerate(text):
        if char.isalpha():
            return text[:index] + char.lower() + text[index + 1:]
    return text


def _tidy(text: str) -> str:
    text = re.sub(r"[ \t]{2,}", " ", text)
    text = re.sub(r"\s+([,.;:!?…])", r"\1", text)
    text = re.sub(r"([,;])(?:\s*[,;])+", r"\1", text)
    text = re.sub(r",\s*\.", ".", text)
    text = re.sub(r"[,;:]+\s*$", ".", text)
    text = re.sub(r"^[\s,;:]+", "", text)
    return text.strip()


def _particle_for(text: str, avoid: tuple[str, ...]) -> str:
    """A stable, non-repeating reaction particle."""
    taken = {fold(word) for word in avoid if str(word or "").strip()}
    start = zlib.crc32(str(text or "").encode("utf-8")) % len(_PARTICLES)
    for step in range(len(_PARTICLES)):
        candidate = _PARTICLES[(start + step) % len(_PARTICLES)]
        if fold(candidate) not in taken:
            return candidate
    return _PARTICLES[start]


def repair_opening(text: str, avoid: tuple[str, ...] = ()) -> str:
    """Prefix a reaction particle so the reply no longer opens on a forbidden word."""
    particle = _particle_for(text, avoid)
    return particle + ", " + _lower_first(str(text or "").lstrip())


def _carries_time(part: str, spans: tuple[str, ...] = ()) -> bool:
    if spans:
        folded = fold(part)
        return any(fold(span) in folded for span in spans)
    return mentions_time(part)


def _strip_time_sentence(sentence: str, spans: tuple[str, ...] = ()) -> str:
    """Drop the clauses that carry a volunteered clock/time-of-day reference."""
    clauses = [part for part in _CLAUSE.split(sentence) if part is not None]
    kept = [part for part in clauses if part.strip() and not _carries_time(part, spans)]
    if not kept:
        return ""
    rebuilt = ", ".join(part.strip() for part in kept)
    rebuilt = re.sub(r"^(?:et|mais|puis)\s+", "", rebuilt, flags=re.IGNORECASE)
    return _tidy(rebuilt)


_DANGLING = "?"
_DANGLING_MID = re.compile(r"(?:(?:d['’]|de|du)\s+)(?=(?:sur|sous|dans|avec|et|ou|,|\.))", re.IGNORECASE)

_DANGLING_TAIL = re.compile(r"(?:[ 	]+(?:d['’]|de|du|des|le|la|les|l['’]|à|a|en|sur|dans|avec|et|ou))+[ 	]*$", re.IGNORECASE)

_dangling = re.compile(r"(?:^|[ 	])(?:avant|après|apres|vers|depuis|plein|pile)(?=[\s,.;:!?…]|$)", re.IGNORECASE)


def _drop_span(text: str, span: str) -> str:
    lead = r"(?:[ 	]*(?:avant|après|apres|vers|dès|depuis|jusqu['’]|à|a|en|dans))?"
    tail = r"(?:[ 	]*(?:pile|tapantes|sonnantes|précises|passées|passés))?"
    return re.sub(lead + "[ 	]*" + re.escape(span) + tail, " ", text, flags=re.IGNORECASE)


def repair_time(text: str, spans: tuple[str, ...] = ()) -> str:
    """Remove volunteered time references, keeping every other sentence intact."""
    parts = _SENTENCE.split(str(text or ""))
    rebuilt: list[str] = []
    removed = False
    for index, part in enumerate(parts):
        if index % 2:  # separator captured by the regex
            rebuilt.append(part)
            continue
        if not _carries_time(part, spans):
            rebuilt.append(part)
            continue
        removed = True
        cleaned = _strip_time_sentence(part, spans)
        if cleaned:
            rebuilt.append(_capitalise(cleaned))
    out = _tidy("".join(rebuilt))
    if not removed:
        return text
    if out and not mentions_time(out):
        return out
    # Every sentence carried the clock: remove just the span, with the
    # preposition that introduced it, instead of emptying the whole turn.
    spans = spans or tuple(_time_spans(text))
    cleaned = text
    for span in spans:
        cleaned = _drop_span(cleaned, span)
    cleaned = _tidy(_dangling.sub(" ", _tidy(cleaned)))
    cleaned = _tidy(_DANGLING_MID.sub(" ", cleaned))
    cleaned = _tidy(_DANGLING_TAIL.sub("", cleaned))
    if cleaned and not mentions_time(cleaned) and len(cleaned.split()) >= 4:
        return _capitalise(cleaned)
    # Nothing warm survived the subtraction: answer with presence, not a husk.
    return "Je suis là, avec toi."


def guard_reply(text: str, *, user_text: str = "", avoid: tuple[str, ...] = ()) -> tuple[str, dict]:
    """Return the reply as it may reach the Master, plus what the guard changed."""
    original = str(text or "")
    guarded = original
    info = {"opening": "", "time": False, "changed": False}
    spans = volunteered_time(guarded, user_text)
    if spans:
        repaired = repair_time(guarded, tuple(spans))
        if repaired != guarded:
            info["time"] = True
            guarded = repaired
    violation = opening_violation(guarded)
    if violation:
        repaired = repair_opening(guarded, avoid)
        if repaired:
            info["opening"] = violation
            guarded = repaired
    info["changed"] = guarded != original
    return guarded, info
