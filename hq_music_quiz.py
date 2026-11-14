"""Quiz Musica: a blind test over the Master's own Spotify library.

Each round plays a library track from a random point through Spotify Connect (play with ``position_ms``)
and offers four titles. The answer stays server-side until the Master guesses; the verdict comes back at once
with a short scripted line, and Musica's own model-written reaction (the song, his streak, the final score)
streams in a moment later. Only allowed endpoints: saved tracks, top tracks, owned playlist items, play.
"""
from __future__ import annotations

import random
import secrets
import threading
import time
from typing import Any

import hq_music as music

QUIZ_FILE = "quiz.json"
ROUND_CHOICES = (5, 10)
SOURCES = ("saved", "top", "playlist")
POOL_MAX = 200

LINES = {
    "right": ["Bien joué, Maître. Oreille affûtée.", "Exact ! Tu l’as reconnu en quelques notes.",
              "Oui ! Celle-là ne t’échappe pas.", "Parfait. Je note le point avec plaisir."],
    "wrong": ["Raté… c’était {answer}. On se rattrape ?", "Pas cette fois : {answer}. Je garde ça pour la revanche.",
              "Presque ! La bonne réponse : {answer}.", "Non, c’était {answer}. Ton oreille va se venger."],
    "end_high": ["{score}/{total} ! Je suis impressionnée.", "{score}/{total}. Tu connais ta bibliothèque par cœur."],
    "end_mid": ["{score}/{total}. Honorable, on rejoue ?", "{score}/{total}. Pas mal du tout, Maître."],
    "end_low": ["{score}/{total}. On dira que Spotify a triché.", "{score}/{total}. Revanche quand tu veux."],
}


LINES_EN = {
    "right": ["Well done, Master. Sharp ears.", "Spot on! You got it in a few notes.",
              "Yes! That one never escapes you.", "Perfect. I'm adding that point with pleasure."],
    "wrong": ["Missed… it was {answer}. Shall we make up for it?", "Not this time: {answer}. I'll save it for the rematch.",
              "So close! The right answer: {answer}.", "No, it was {answer}. Your ears will get their revenge."],
    "end_high": ["{score}/{total}! I'm impressed.", "{score}/{total}. You know your library by heart."],
    "end_mid": ["{score}/{total}. Respectable. Again?", "{score}/{total}. Not bad at all, Master."],
    "end_low": ["{score}/{total}. Let's say Spotify cheated.", "{score}/{total}. Rematch whenever you like."],
}


def _line(kind: str, **fields: Any) -> str:
    try:
        import hq_music_dj
        pool = LINES_EN if hq_music_dj.show_language() == "en" else LINES
    except Exception:  # noqa: BLE001
        pool = LINES
    return random.choice(pool[kind]).format(**fields)


def _label(track: dict[str, Any]) -> str:
    return f"{track.get('name') or '?'} — {', '.join(track.get('artists') or []) or '?'}"


def _pool(source: str, playlist_id: str | None) -> list[dict[str, Any]]:
    import hq_spotify as spotify

    rows: list[dict[str, Any]] = []
    if source == "saved":
        for offset in range(0, POOL_MAX, 50):
            page = spotify.saved_tracks(50, offset)
            rows += page.get("tracks") or []
            if not page.get("next"):
                break
    elif source == "top":
        for period in ("short", "medium", "long"):
            rows += spotify.top_tracks(period, limit=50).get("tracks") or []
    else:
        if not isinstance(playlist_id, str) or not playlist_id:
            raise music.MusicError("Playlist requise pour ce quiz")
        rows = spotify.collect_playlist_tracks(playlist_id, max_tracks=POOL_MAX)
    seen: set[str] = set()
    pool = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        uri, name = row.get("uri"), str(row.get("name") or "").strip()
        key = name.casefold()
        if not isinstance(uri, str) or not uri.startswith("spotify:track:") or not name or key in seen:
            continue
        seen.add(key)
        pool.append({"uri": uri, "name": name[:160], "artists": [str(a)[:80] for a in row.get("artists") or []][:4],
                     "duration_ms": row.get("duration_ms") if isinstance(row.get("duration_ms"), int) else None,
                     "image": row.get("image")})
    return pool


def _choices(answer: dict[str, Any], pool: list[dict[str, Any]], rng: random.Random) -> list[dict[str, Any]]:
    others = [t for t in pool if t["uri"] != answer["uri"]]
    lead = {a.casefold() for a in answer["artists"]}
    # Prefer other artists so the guess is about the song, not a coin flip between namesakes.
    different = [t for t in others if not lead & {a.casefold() for a in t["artists"]}]
    picks = rng.sample(different, 3) if len(different) >= 3 else rng.sample(others, 3)
    options = picks + [answer]
    rng.shuffle(options)
    return options


def start(body: dict[str, Any]) -> dict[str, Any]:
    rounds = body.get("rounds", 5)
    source = body.get("source", "saved")
    if rounds not in ROUND_CHOICES:
        raise music.MusicError("Nombre de manches invalide (5 ou 10)")
    if source not in SOURCES:
        raise music.MusicError("Source de quiz invalide")
    pool = _pool(source, body.get("playlist_id"))
    if len(pool) < max(8, rounds + 3):
        raise music.MusicError("Il faut au moins 8 titres différents dans cette source pour jouer.", 409,
                               "quiz_pool_small")
    rng = random.Random(secrets.randbits(64))
    answers = rng.sample(pool, rounds)
    plan = []
    for answer in answers:
        options = _choices(answer, pool, rng)
        duration = answer.get("duration_ms") or 180000
        position = int(duration * rng.uniform(0.2, 0.6))
        plan.append({"uri": answer["uri"], "answer": options.index(answer), "position_ms": position,
                     "image": answer.get("image"),
                     "choices": [{"name": o["name"], "artists": o["artists"]} for o in options]})
    game = {"id": secrets.token_hex(8), "source": source, "started": time.time(), "rounds": plan,
            "current": -1, "score": 0, "answered": [], "best": music._load(QUIZ_FILE, {}).get("best", 0)}
    music._write(QUIZ_FILE, game)
    return _public(game)


def _game(game_id: Any) -> dict[str, Any]:
    game = music._load(QUIZ_FILE, {})
    if not game.get("id") or game.get("id") != game_id:
        raise music.MusicError("Partie introuvable — relance un quiz", 404, "quiz_missing")
    return game


def _public(game: dict[str, Any]) -> dict[str, Any]:
    index = game.get("current", -1)
    current = game["rounds"][index] if 0 <= index < len(game["rounds"]) else None
    done = len(game.get("answered") or []) >= len(game["rounds"])
    return {"id": game["id"], "total": len(game["rounds"]), "round": index + 1, "score": game.get("score", 0),
            "best": game.get("best", 0), "done": done,
            "awaiting": bool(current) and len(game.get("answered") or []) == index,
            "choices": current["choices"] if current else []}


def next_round(game_id: Any) -> dict[str, Any]:
    import hq_spotify as spotify

    game = _game(game_id)
    answered = len(game.get("answered") or [])
    if answered >= len(game["rounds"]):
        raise music.MusicError("La partie est terminée", 409, "quiz_done")
    if game["current"] >= answered:
        index = game["current"]  # replay the same round (device changed, etc.)
    else:
        index = answered
    game["current"] = index
    music._write(QUIZ_FILE, game)
    current = game["rounds"][index]
    try:
        spotify.player_action("play", {"uris": [current["uri"]], "position_ms": current["position_ms"],
                                       "auto_device": True})
    except spotify.SpotifyError as exc:
        return {"ok": False, "code": exc.code, "error": str(exc), **_public(game)}
    return {"ok": True, **_public(game)}


def answer(game_id: Any, choice: Any) -> dict[str, Any]:
    game = _game(game_id)
    index = game.get("current", -1)
    answered = game.setdefault("answered", [])
    if not 0 <= index < len(game["rounds"]) or len(answered) != index:
        raise music.MusicError("Aucune manche en attente de réponse", 409, "quiz_no_round")
    if type(choice) is not int or not 0 <= choice < 4:
        raise music.MusicError("Choix invalide")
    current = game["rounds"][index]
    right = choice == current["answer"]
    answered.append(choice)
    game["score"] = game.get("score", 0) + (1 if right else 0)
    correct = current["choices"][current["answer"]]
    label = _label(correct)
    line = _line("right") if right else _line("wrong", answer=label)
    done = len(answered) >= len(game["rounds"])
    stored = music._load(QUIZ_FILE, {})
    best_before = int(stored.get("best") or 0)
    if done:
        total, score = len(game["rounds"]), game["score"]
        ratio = score / total
        line += " " + _line("end_high" if ratio >= 0.8 else "end_mid" if ratio >= 0.5 else "end_low",
                            score=score, total=total)
        game["best"] = max(best_before, score)
    music._write(QUIZ_FILE, game)
    streak = 0
    for i in range(len(answered) - 1, -1, -1):
        if answered[i] == game["rounds"][i]["answer"]:
            streak += 1
        else:
            break
    facts = {"right": right, "track": label, "picked": None if right else _label(current["choices"][choice]),
             "round": index + 1, "total": len(game["rounds"]), "score": game["score"], "streak": streak,
             "done": done, "best_before": best_before}
    rid = f"{game['id']}-{index}"
    _reactions[rid] = {"pending": True, "text": line}
    while len(_reactions) > 8:
        _reactions.pop(next(iter(_reactions)))
    threading.Thread(target=_stream_reaction, args=(rid, facts, line), daemon=True, name="quiz-reaction").start()
    return {"ok": True, "right": right, "correct": {**correct, "uri": current["uri"], "image": current.get("image")},
            "line": line, "reaction": {"id": rid, "pending": True}, **_public(game)}


_reactions: dict[str, dict[str, Any]] = {}  # "<game>-<round>" -> her reaction while the model is still writing it


def _write_reaction(facts: dict[str, Any]) -> str:
    """One short spoken sentence from the model about this answer; empty on any failure (the scripted line stands)."""
    import hq_ai
    import hq_music_dj
    import hq_musica

    language = hq_music_dj.show_language()
    lang = "in English" if language == "en" else "in French"
    state = []
    state.append("He was RIGHT." if facts["right"] else f"He was WRONG and picked: {facts['picked']}.")
    state.append(f"The track was: {facts['track']}.")
    state.append(f"Round {facts['round']} of {facts['total']}; score so far {facts['score']}/{facts['round']}; "
                 f"current streak of correct answers: {facts['streak']}.")
    if facts["done"]:
        state.append(f"The game is OVER: final score {facts['score']}/{facts['total']} "
                     f"(his previous best was {facts['best_before']}). Say the final score and react to it.")
    guide = ""
    try:
        guide = hq_music_dj.charm_rule()
    except Exception:  # noqa: BLE001
        guide = ""
    system = (hq_musica.PERSONA_CORE + "\nYou are running a blind-test quiz on the Master's own Spotify library. "
              "React to his answer with ONE or TWO short spoken sentences (max 150 characters in total), "
              + lang + ", no emoji, no quotation marks, no markdown. Tease or praise him, mention the song or the "
              "artist naturally (they are revealed now), and vary your wording; never repeat the scripted line. "
              "Invent no fact about the song beyond its title and artist." + guide)
    raw, _model = hq_ai.generate(hq_musica.DANCE_CHAIN, system,
                                 [{"role": "user", "parts": [{"text": " ".join(state)}]}],
                                 max_tokens=120, temperature=0.9, background=True,
                                 deadline=time.monotonic() + 12)
    text = " ".join(str(raw or "").strip().strip('"').split())
    return hq_musica._safe_text(text)[:220] if len(text) >= 6 else ""


def _stream_reaction(rid: str, facts: dict[str, Any], canned: str) -> None:
    try:
        text = _write_reaction(facts)
    except Exception:  # noqa: BLE001 - the scripted line already stands
        text = ""
    _reactions[rid] = {"pending": False, "text": text or canned}


def reaction_view(rid: str) -> dict[str, Any]:
    row = _reactions.get(str(rid)[:80])
    if not row:
        return {"ok": True, "pending": False, "text": ""}
    return {"ok": True, "pending": bool(row.get("pending")), "text": "" if row.get("pending") else row.get("text", "")}


def status() -> dict[str, Any]:
    game = music._load(QUIZ_FILE, {})
    if not game.get("id"):
        return {"ok": True, "game": None, "best": game.get("best", 0)}
    return {"ok": True, "game": _public(game), "best": game.get("best", 0)}
