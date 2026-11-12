"""Transfert HQ custom DJ / mixer — local weighted session generation.

No network I/O. No Spotify HTTP. No LLM. Inputs are caller-assembled track
metadata and an explicit config. Deprecated Spotify recommendation / audio-feature
APIs are intentionally unused.
"""
from __future__ import annotations

from typing import Any
import copy
import random


class MixerError(ValueError):
    def __init__(self, message: str, code: str = "validation_error") -> None:
        super().__init__(message)
        self.code = code


DEFAULT_PRESETS: dict[str, dict[str, Any]] = {
    "industrial-night": {
        "id": "industrial-night",
        "name": "Industrial Night",
        "config": {
            "length": 40,
            "familiarity": 0.55,
            "artist_window": 4,
            "favorites_boost": 0.2,
            "max_artist_frequency": 3,
        },
        "sources": [],
    },
    "power-metal": {
        "id": "power-metal",
        "name": "Power Metal",
        "config": {
            "length": 35,
            "familiarity": 0.65,
            "artist_window": 3,
            "favorites_boost": 0.25,
            "max_artist_frequency": 4,
        },
        "sources": [],
    },
    "heavy-rotation": {
        "id": "heavy-rotation",
        "name": "Heavy Rotation",
        "config": {
            "length": 30,
            "familiarity": 0.85,
            "artist_window": 2,
            "favorites_boost": 0.35,
            "max_artist_frequency": 5,
        },
        "sources": [],
    },
    "focus": {
        "id": "focus",
        "name": "Focus",
        "config": {
            "length": 25,
            "familiarity": 0.4,
            "artist_window": 5,
            "favorites_boost": 0.1,
            "max_artist_frequency": 2,
        },
        "sources": [],
    },
    "discovery": {
        "id": "discovery",
        "name": "Discovery",
        "config": {
            "length": 30,
            "familiarity": 0.15,
            "artist_window": 6,
            "favorites_boost": 0.05,
            "max_artist_frequency": 2,
        },
        "sources": [],
    },
    "mixed-chaos": {
        "id": "mixed-chaos",
        "name": "Mixed Chaos",
        "config": {
            "length": 40,
            "familiarity": 0.35,
            "artist_window": 1,
            "favorites_boost": 0.1,
            "max_artist_frequency": 8,
        },
        "sources": [],
    },
}


def normalize_weights(weights: list[float]) -> list[float]:
    cleaned = []
    for w in weights:
        try:
            value = float(w)
        except (TypeError, ValueError) as exc:
            raise MixerError("Poids invalide") from exc
        if value < 0:
            raise MixerError("Poids négatif interdit")
        cleaned.append(value)
    total = sum(cleaned)
    if total <= 0:
        n = len(cleaned)
        if n == 0:
            return []
        return [1.0 / n] * n
    return [w / total for w in cleaned]


def _as_artists(raw: Any) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        value = raw.strip()
        return [value] if value else []
    if isinstance(raw, list):
        out = []
        for item in raw:
            if isinstance(item, str) and item.strip():
                out.append(item.strip())
            elif isinstance(item, dict):
                name = item.get("name")
                if isinstance(name, str) and name.strip():
                    out.append(name.strip())
        return out
    return []


def _track_id(track: dict[str, Any]) -> str:
    for key in ("id", "track_id", "uri"):
        value = track.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    raise MixerError("Piste sans identifiant")


def _play_count(track: dict[str, Any]) -> float:
    raw = track.get("play_count", track.get("plays", 0))
    try:
        return max(0.0, float(raw))
    except (TypeError, ValueError):
        return 0.0


def _score_track(
    track: dict[str, Any],
    *,
    familiarity: float,
    favorite_track_ids: set[str],
    favorite_artists: set[str],
    favorites_boost: float,
) -> float:
    tid = _track_id(track)
    plays = _play_count(track)
    # Map play counts into a soft 0..1 familiarity signal.
    fam_signal = min(1.0, plays / 10.0) if plays else 0.05
    # familiarity=1 prefers known; familiarity=0 prefers obscure.
    base = (familiarity * fam_signal) + ((1.0 - familiarity) * (1.0 - fam_signal))
    boost = 0.0
    if tid in favorite_track_ids or track.get("uri") in favorite_track_ids:
        boost += favorites_boost
    artists = {a.casefold() for a in _as_artists(track.get("artists"))}
    if artists & favorite_artists:
        boost += favorites_boost * 0.5
    return max(0.001, base + boost)


def generate_session(
    sources: list[dict[str, Any]] | None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build an explainable listening session from weighted playlist sources."""
    if not isinstance(sources, list) or not sources:
        raise MixerError("Au moins une source playlist est requise")
    cfg = config if isinstance(config, dict) else {}
    length = int(cfg.get("length", 30) or 30)
    if length < 1 or length > 100:
        raise MixerError("Longueur de session hors plage (1–100)")
    familiarity = float(cfg.get("familiarity", 0.5))
    if "exploration" in cfg and "familiarity" not in cfg:
        familiarity = 1.0 - float(cfg.get("exploration", 0.5))
    familiarity = min(1.0, max(0.0, familiarity))
    artist_window = max(0, int(cfg.get("artist_window", 3) or 0))
    max_artist_frequency = cfg.get("max_artist_frequency")
    max_artist_freq = int(max_artist_frequency) if max_artist_frequency is not None else None
    if max_artist_freq is not None and max_artist_freq < 1:
        raise MixerError("max_artist_frequency invalide")
    favorites_boost = float(cfg.get("favorites_boost", 0.15) or 0.0)
    allow_relax = bool(cfg.get("allow_relax", True))
    seed = cfg.get("seed")
    rng = random.Random(int(seed) if seed is not None else None)
    used_seed = rng.randint(0, 2**31 - 1) if seed is None else int(seed)
    rng = random.Random(used_seed)

    avoid_recent = {str(x) for x in (cfg.get("avoid_recent_ids") or []) if isinstance(x, (str, int))}
    exclude_tracks = {str(x) for x in (cfg.get("exclude_track_ids") or []) if isinstance(x, (str, int))}
    exclude_artists = {
        str(x).casefold() for x in (cfg.get("exclude_artists") or []) if isinstance(x, str) and x.strip()
    }
    cooldown = {str(x) for x in (cfg.get("cooldown_ids") or []) if isinstance(x, (str, int))}
    favorite_track_ids = {str(x) for x in (cfg.get("favorite_track_ids") or []) if isinstance(x, (str, int))}
    favorite_artists = {
        str(x).casefold() for x in (cfg.get("favorite_artists") or []) if isinstance(x, str) and x.strip()
    }

    prepared: list[dict[str, Any]] = []
    for raw in sources:
        if not isinstance(raw, dict):
            raise MixerError("Source invalide")
        sid = str(raw.get("id") or raw.get("playlist_id") or "").strip()
        name = str(raw.get("name") or sid or "Source").strip() or "Source"
        try:
            weight = float(raw.get("weight", 1.0))
        except (TypeError, ValueError) as exc:
            raise MixerError(f"Poids invalide pour {name}") from exc
        tracks_in = raw.get("tracks")
        if not isinstance(tracks_in, list):
            raise MixerError(f"Tracks manquants pour {name}")
        cleaned_tracks = []
        for item in tracks_in:
            if not isinstance(item, dict):
                continue
            try:
                tid = _track_id(item)
            except MixerError:
                continue
            if tid in exclude_tracks:
                continue
            artists = _as_artists(item.get("artists"))
            if any(a.casefold() in exclude_artists for a in artists):
                continue
            cleaned_tracks.append({
                "id": tid,
                "uri": item.get("uri") if isinstance(item.get("uri"), str) else (f"spotify:track:{tid}" if not tid.startswith("spotify:") else tid),
                "name": str(item.get("name") or item.get("title") or tid)[:160],
                "artists": artists,
                "artist_ids": [str(x) for x in (item.get("artist_ids") or []) if isinstance(x, str)],
                "play_count": _play_count(item),
                "album": item.get("album") if isinstance(item.get("album"), str) else None,
                "image": item.get("image") if isinstance(item.get("image"), str) else None,
            })
        if weight <= 0 or not cleaned_tracks:
            continue
        prepared.append({"id": sid or name, "name": name, "weight": weight, "tracks": cleaned_tracks})

    if not prepared:
        raise MixerError("Aucune source utilisable après filtres")

    weights = normalize_weights([s["weight"] for s in prepared])
    for source, weight in zip(prepared, weights):
        source["weight_share"] = weight

    picks: list[dict[str, Any]] = []
    compromises: list[str] = []
    recent_artists: list[str] = []
    artist_counts: dict[str, int] = {}
    picked_ids: set[str] = set()

    def eligible(track: dict[str, Any], *, use_artist_window: bool, use_max_freq: bool, use_cooldown: bool) -> bool:
        tid = track["id"]
        if tid in picked_ids:
            return False
        if tid in avoid_recent or tid in exclude_tracks:
            return False
        if use_cooldown and tid in cooldown:
            return False
        artists = [a.casefold() for a in track["artists"]]
        if any(a in exclude_artists for a in artists):
            return False
        if picks and picks[-1]["id"] == tid:
            return False
        if use_artist_window and artist_window > 0:
            window = recent_artists[-artist_window:]
            if any(a in window for a in artists):
                return False
        if use_max_freq and max_artist_freq is not None:
            for a in artists:
                if artist_counts.get(a, 0) >= max_artist_freq:
                    return False
        return True

    relax_levels = [
        {"artist_window": True, "max_freq": True, "cooldown": True, "label": None},
        {"artist_window": False, "max_freq": True, "cooldown": True, "label": "fenêtre artiste assouplie"},
        {"artist_window": False, "max_freq": False, "cooldown": True, "label": "limite fréquence artiste assouplie"},
        {"artist_window": False, "max_freq": False, "cooldown": False, "label": "cooldown assoupli"},
    ]
    if not allow_relax:
        relax_levels = relax_levels[:1]

    for slot in range(length):
        chosen = None
        chosen_source = None
        reason_parts: list[str] = []
        level_used = None

        for level in relax_levels:
            # Prefer weighted source, then fall back across all sources.
            order = list(range(len(prepared)))
            primary = rng.choices(order, weights=weights, k=1)[0]
            search_order = [primary] + [i for i in order if i != primary]
            for idx in search_order:
                source = prepared[idx]
                candidates = [
                    t for t in source["tracks"]
                    if eligible(
                        t,
                        use_artist_window=level["artist_window"],
                        use_max_freq=level["max_freq"],
                        use_cooldown=level["cooldown"],
                    )
                ]
                if not candidates:
                    continue
                scores = [
                    _score_track(
                        t,
                        familiarity=familiarity,
                        favorite_track_ids=favorite_track_ids,
                        favorite_artists=favorite_artists,
                        favorites_boost=favorites_boost,
                    )
                    for t in candidates
                ]
                pick = rng.choices(candidates, weights=scores, k=1)[0]
                chosen = pick
                chosen_source = source
                reason_parts = [
                    f"source « {source['name']} » ({round(source['weight_share'] * 100)}%)",
                    f"familiarité {familiarity:.2f}",
                ]
                if pick["id"] in favorite_track_ids or any(a.casefold() in favorite_artists for a in pick["artists"]):
                    reason_parts.append("favori renforcé")
                if idx != primary:
                    reason_parts.append("repli inter-sources")
                level_used = level
                break
            if chosen is not None:
                break

        if chosen is None or chosen_source is None:
            compromises.append(f"arrêt anticipé au créneau {slot + 1}: plus de candidats")
            break

        if level_used and level_used.get("label"):
            msg = level_used["label"]
            if msg not in compromises:
                compromises.append(msg)
            reason_parts.append(msg)

        artists = chosen["artists"]
        for a in artists:
            key = a.casefold()
            artist_counts[key] = artist_counts.get(key, 0) + 1
            recent_artists.append(key)
        picked_ids.add(chosen["id"])
        picks.append({
            **chosen,
            "source_id": chosen_source["id"],
            "source_name": chosen_source["name"],
            "weight_share": chosen_source["weight_share"],
            "reason": "; ".join(reason_parts),
            "position": len(picks) + 1,
        })

    return {
        "ok": True,
        "seed": used_seed,
        "tracks": picks,
        "compromises": compromises,
        "stats": {
            "requested": length,
            "generated": len(picks),
            "sources": [
                {"id": s["id"], "name": s["name"], "weight_share": s["weight_share"], "pool": len(s["tracks"])}
                for s in prepared
            ],
            "familiarity": familiarity,
            "artist_window": artist_window,
            "max_artist_frequency": max_artist_freq,
        },
    }


def list_builtin_presets() -> list[dict[str, Any]]:
    return [copy.deepcopy(v) for v in DEFAULT_PRESETS.values()]
