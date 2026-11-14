"""DJ Musica — live reactions: short, instant lines when something happens on air.

A reaction is a one-liner (« Aïe, raté. Je note. ») tied to an event the show can see by itself: a quick skip of her
pick, three skips in a row, a bet won or lost, or the acknowledgement of a spoken request. It must feel instant, so
the voice is prepared in advance: ``warm`` records the lines in the background while the show is quiet, and ``react``
prefers a line whose drop is already in the cache. When none is ready the text still goes out at once (the chip says it)
and the voice of that line is queued for next time, so the show never waits for a synthesis.

Pacing keeps her from becoming a commentator: a minimum gap between two reactions, a minimum number of tracks, a
probability per event, and no line repeated within the last twelve. All of it lives in ``state["live"]``.
"""

from __future__ import annotations

import random
import re
import time
from typing import Any

import hq_music_dj as dj

# event -> probability, minimum seconds since the last reaction, minimum tracks since the last reaction, lines per language
EVENTS: dict[str, dict[str, Any]] = {
    "skip": {"p": 0.5, "gap": 150, "tracks": 2, "lines": {
        "fr": ["[playful] Aïe, raté. Je note.", "[warm] D'accord, pas celle-là. Je recalibre.", "[playful] Pas ton truc ? J'en ai d'autres.",
               "[warm] Compris, on passe à autre chose.", "[playful] Ok ok, message reçu.", "[tender] Pas grave, la suivante est pour toi."],
        "en": ["[playful] Ouch, missed. Noted.", "[warm] Alright, not that one. Recalibrating.", "[playful] Not your thing? I have others.",
               "[warm] Understood, let's move on.", "[playful] Okay okay, message received.", "[tender] No worries, the next one is for you."]}},
    "skips": {"p": 0.9, "gap": 75, "tracks": 1, "lines": {
        "fr": ["[warm] Tu zappes beaucoup : je change d'angle.", "[tender] Dis-moi ce qui ne va pas, et je corrige.",
               "[playful] Trois de suite ? Dis-moi ce que tu veux entendre, je te suis.", "[warm] Je sens que ça ne passe pas. Une direction, peut-être ?"],
        "en": ["[warm] You're skipping a lot: I'm changing angle.", "[tender] Tell me what's off and I'll fix it.",
               "[playful] Three in a row? Tell me what you want to hear, I'll follow.", "[warm] I can tell it isn't landing. A direction, maybe?"]}},
    "pick_won": {"p": 0.8, "gap": 90, "tracks": 1, "lines": {
        "fr": ["[hype] Et voilà, pari gagné !", "[playful] Je te l'avais dit. Un point pour moi.", "[hype] Celle-là, tu l'as écoutée jusqu'au bout. Je triomphe.",
               "[playful] Mon pari paie. Je ne dis rien, je savoure."],
        "en": ["[hype] And there it is, bet won!", "[playful] Told you so. One point for me.", "[hype] You played that one to the end. I'm triumphant.",
               "[playful] My bet pays off. I'm not saying anything, I'm savouring it."]}},
    "pick_lost": {"p": 0.8, "gap": 90, "tracks": 1, "lines": {
        "fr": ["[playful] Mon pari tombe à l'eau. Joli, mais pas pour toi.", "[tender] J'avais parié sur celle-là… raté. Je m'en souviens.",
               "[warm] Perdu. Je range ça dans ce que tu n'aimes pas.", "[playful] Pari perdu. Je reviendrai plus fine."],
        "en": ["[playful] My bet falls flat. Pretty, but not for you.", "[tender] I bet on that one… missed. I'll remember.",
               "[warm] Lost. Filing it under what you don't like.", "[playful] Bet lost. I'll come back sharper."]}},
    "ack": {"p": 1.0, "gap": 0, "tracks": 0, "lines": {
        "fr": ["[warm] Hmm, laisse-moi voir ça.", "[playful] Ça marche, je m'en occupe.", "[warm] Reçu. Je prépare ça.",
               "[hype] Bien sûr, un instant.", "[warm] D'accord, je change de cap."],
        "en": ["[warm] Hmm, let me see.", "[playful] You got it, on it.", "[warm] Received. Preparing that.",
               "[hype] Of course, one moment.", "[warm] Alright, changing course."]}},
}
RECENT = 12
SKIP_STREAK = 3
SKIP_WINDOW = 360  # seconds: three quick skips inside this window make a streak
WARM_EVERY = 600   # seconds between two warm-up runs
WARM_LIMIT = 6     # lines recorded per run: each one takes a few seconds of voice time
_TAG = re.compile(r"^\[(neutral|warm|hype|playful|tender|mysterious)\]\s*", re.I)


def mood_of(line: str) -> str:
    match = _TAG.match(line)
    return match.group(1).lower() if match else "neutral"


def lines_for(event: str, language: str) -> list[str]:
    return list(EVENTS[event]["lines"].get("en" if language == "en" else "fr", []))


def _live(state: dict[str, Any]) -> dict[str, Any]:
    return state.setdefault("live", {"last_at": 0.0, "tracks": 99, "recent": [], "skip_times": [], "warm_at": 0.0})


def tick_track(state: dict[str, Any]) -> None:
    """One more track went by since her last reaction (called once per observed track change)."""
    live = _live(state)
    live["tracks"] = int(live.get("tracks") or 0) + 1


def note_skip(state: dict[str, Any], now: float | None = None) -> bool:
    """Record a quick skip; True when it makes a streak of SKIP_STREAK inside SKIP_WINDOW."""
    now = now or time.time()
    live = _live(state)
    times = [t for t in live.get("skip_times") or [] if now - t < SKIP_WINDOW] + [now]
    live["skip_times"] = times[-6:]
    if len(times) >= SKIP_STREAK:
        live["skip_times"] = []
        return True
    return False


def choose(state: dict[str, Any], event: str, language: str, *, now: float | None = None, rng: random.Random | None = None,
           force: bool = False) -> dict[str, Any] | None:
    """Decide whether she reacts and pick the line; mutates state['live'] (the caller saves). None = stay quiet.
    A line whose voice is already cached is preferred; otherwise the text goes out alone and its voice is queued."""
    spec = EVENTS.get(event)
    if not spec:
        return None
    now = now or time.time()
    rng = rng or random
    live = _live(state)
    if not force:
        if now - float(live.get("last_at") or 0) < spec["gap"] or int(live.get("tracks") or 0) < spec["tracks"]:
            return None
        if rng.random() > spec["p"]:
            return None
    pool = [line for line in lines_for(event, language) if line not in (live.get("recent") or [])] or lines_for(event, language)
    if not pool:
        return None
    ready = [line for line in pool if dj.peek_drop(line, mood=mood_of(line))]
    line = rng.choice(ready or pool)
    live.update(last_at=now, tracks=0, recent=(list(live.get("recent") or []) + [line])[-RECENT:])
    drop = dj.peek_drop(line, mood=mood_of(line))
    return {"event": event, "text": _TAG.sub("", line), "line": line, "drop": drop, "mood": mood_of(line)}


def warm(language: str | None = None, limit: int = WARM_LIMIT) -> int:  # positional: it runs through _spawn(key, fn, *args)
    """Record the voice of lines that are not cached yet, one at a time, only while nothing else needs the voice
    (a segment being prepared would queue behind these lines). Returns how many lines were recorded."""
    language = language or dj.show_language()
    done = 0
    order = ["skip", "pick_won", "pick_lost", "skips", "ack"]
    for event in order:
        for line in lines_for(event, language):
            if done >= limit:
                return done
            if dj.peek_drop(line, mood=mood_of(line)):
                continue
            if dj.voice_busy():
                return done
            if dj.make_drop(line, mood=mood_of(line), language=language):
                done += 1
    return done


def warm_due(state: dict[str, Any], now: float | None = None) -> bool:
    """True once per WARM_EVERY (and marks it): the caller then spawns warm() in the background."""
    now = now or time.time()
    live = _live(state)
    if now - float(live.get("warm_at") or 0) < WARM_EVERY:
        return False
    live["warm_at"] = now
    return True


def queue_voice(line: str, language: str) -> None:
    """Record one line's voice in the background (a reaction that went out as text only)."""
    if dj.peek_drop(line, mood=mood_of(line)) or dj.voice_busy():
        return
    dj.make_drop(line, mood=mood_of(line), language=language)
