"""Musica — Deep multi-source profile fetcher and taste analyzer.

Fuses Spotify catalog/library/playlist signals with ALL local HQ behavioral
data (listening journal, DJ completion/skip telemetry, DJ dig cache,
tournaments & rivalry, Release Radar, track feedback history, SMTC play memory,
beat-grid BPM measurements, LRCLIB lyrics, public MusicBrainz/iTunes metadata,
read-only calendar context, and Master's manual overrides) to build a
14-layer empirical & psychological model of the Master's musical identity.

Never imports iphone_bridge. All state goes through hq_music / hq_state.
"""
from __future__ import annotations

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
import json
import math
import re
import threading
import time
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

import hq_music as music
import hq_state

RAW_FILE = "musica_profile_raw.json"
ANALYSIS_FILE = "musica_profile_analysis.json"
OVERRIDES_FILE = "musica_profile_overrides.json"
LYRICS_CACHE_FILE = "musica_lyrics_cache.json"
HISTORY_FILE = "musica_profile_history.json"

RAW_TTL_SEC = 6 * 3600
ARTIST_CACHE_TTL_SEC = 30 * 86400
PUBLIC_CACHE_TTL_SEC = 60 * 86400
LYRICS_TTL_SEC = 60 * 86400
TICK_INTERVAL_SEC = 24 * 3600

MAX_PLAYLISTS_FETCH = 45
MAX_PLAYLIST_TRACKS = 250
MAX_SAVED_TRACKS = 2000
MAX_SAVED_ALBUMS = 250
MAX_ARTIST_ENRICH = 200
MAX_JOURNAL_SEARCH_ENRICH = 25
MAX_PUBLIC_ENRICH = 22
MAX_LYRICS_FETCH = 25
PUBLIC_ENRICH_BUDGET_SEC = 10.0
LINK_GAP_SEC = 25 * 60

MOOD_RULE_KEYS = ("matin", "apres-midi", "soiree", "nuit", "sport", "focus")
DAYS_FR = ("lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche")

_job_lock = threading.Lock()
_job_state: dict[str, Any] = {
    "running": False,
    "stage": "idle",
    "pct": 0,
    "label": "",
    "error": None,
    "started_utc": None,
    "finished_utc": None,
}

MACRO_GENRE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Metal & Heavy", (
        "metal", "metalcore", "deathcore", "djent", "thrash", "hard rock",
        "nu metal", "symphonic", "power metal", "heavy", "melodeath", "doom",
        "neue deutsche harte",
    )),
    ("Phonk & Drift", (
        "phonk", "montagem", "funk brasileiro", "brazilian funk", "drift",
        "memphis", "cowbell", "automotivo", "sigilkore",
    )),
    ("Industrial & Dark Synth", (
        "industrial", "ebm", "aggrotech", "darksynth", "synthwave", "cyberpunk",
        "witch house", "darkwave", "tanzmetall", "gothic",
    )),
    ("Electronic & Dance", (
        "edm", "electro", "house", "techno", "trance", "dubstep",
        "drum and bass", "dnb", "neurofunk", "hardstyle", "rawstyle",
        "frenchcore", "rave", "dance", "eurobeat", "electronic", "breakbeat",
        "hyperpop",
    )),
    ("Anime / J-Rock / Gaming", (
        "j-pop", "j-rock", "anime", "vocaloid", "nerdcore", "otacore",
        "video game", "vgm", "k-pop", "k-rock", "chiptune", "doujin",
    )),
    ("Soundtrack & Orchestral", (
        "soundtrack", "orchestral", "epicore", "score", "cinematic",
        "classical", "trailer", "neoclassical",
    )),
    ("Hip-Hop & Trap", (
        "hip hop", "hip-hop", "rap", "trap", "drill", "comedy rap",
        "meme rap", "boom bap", "trap metal",
    )),
    ("Latin & Urban", ("reggaeton", "bachata", "latin", "salsa", "urbano", "corrido")),
    ("Country & Folk", ("country", "americana", "folk", "bluegrass", "southern", "celtic")),
    ("Rock & Alternative", ("rock", "punk", "grunge", "emo", "alternative", "indie rock", "post-hardcore")),
    ("Pop & Indie", ("pop", "indie", "synthpop", "r&b", "soul")),
)

PLAYLIST_ARCHETYPE_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("Workout / Training", ("train", "gym", "workout", "sport", "lift", "pump", "run", "cardio", "beast", "war")),
    ("Focus / Deep Work", ("focus", "code", "coding", "study", "work", "travail", "concentr", "ambient", "lofi")),
    ("Night / Chill", ("night", "nuit", "chill", "sleep", "calm", "soft", "late", "lounge", "slow")),
    ("Hype / Party", ("party", "hype", "banger", "club", "rave", "car", "drive", "drift", "phonk")),
    ("Gaming / Lore", ("game", "gaming", "boss", "raid", "ost", "anime", "epic", "battle")),
)

# Family coordinates along 6 normalized sonic tendencies (0..1 weights)
_FAMILY_SONIC_WEIGHTS: dict[str, tuple[float, float, float, float, float]] = {
    # family: (aggression, adrenaline, darkness, theatricality, underground_bias)
    "Metal & Heavy":            (0.95, 0.72, 0.72, 0.86, 0.45),
    "Phonk & Drift":            (0.70, 0.96, 0.84, 0.25, 0.72),
    "Industrial & Dark Synth":  (0.86, 0.80, 0.96, 0.65, 0.78),
    "Electronic & Dance":       (0.45, 0.90, 0.40, 0.45, 0.50),
    "Anime / J-Rock / Gaming":  (0.55, 0.82, 0.35, 0.90, 0.55),
    "Soundtrack & Orchestral":  (0.35, 0.48, 0.55, 0.98, 0.48),
    "Hip-Hop & Trap":           (0.58, 0.72, 0.60, 0.28, 0.40),
    "Latin & Urban":            (0.28, 0.75, 0.20, 0.22, 0.30),
    "Country & Folk":           (0.20, 0.42, 0.25, 0.50, 0.42),
    "Rock & Alternative":       (0.62, 0.64, 0.52, 0.55, 0.42),
    "Pop & Indie":              (0.18, 0.54, 0.24, 0.42, 0.35),
    "Other / Experimental":     (0.45, 0.55, 0.55, 0.55, 0.65),
}

_LYRIC_THEMES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("epic_battle_fantasy", (
        "battle", "king", "kingdom", "sword", "glory", "war", "dragon",
        "steel", "fire", "victory", "honor", "blood", "hero", "knight", "army",
    )),
    ("dark_industrial_intensity", (
        "machine", "wire", "void", "shadow", "burn", "pain", "break",
        "system", "static", "bleed", "dark", "neon", "ashes", "chaos", "hell",
    )),
    ("hype_phonk_adrenaline", (
        "montagem", "batidao", "batidão", "drift", "bass", "night", "fast",
        "speed", "phonk", "toma", "vai", "fogo", "noite", "automotivo", "adrenalina",
    )),
    ("introspective_emotional", (
        "heart", "love", "alone", "memory", "sky", "tears", "dream",
        "hold", "home", "heaven", "soul", "sorry", "ghost", "silence",
    )),
    ("comedy_satire_nerdcore", (
        "lol", "bro", "money", "party", "meme", "game", "boss", "level",
        "super", "crazy", "anime", "gachiakuta", "moshpit",
    )),
)

_LANG_STOPWORDS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("fr", (" je ", " tu ", " il ", " nous ", " vous ", " les ", " des ", " une ", " dans ", " pour ", " avec ", " pas ", " est ", " c'est ")),
    ("pt", (" não ", " nao ", " que ", " você ", " voce ", " com ", " para ", " por ", " uma ", " mais ", " vai ", " toma ", " tudo ", " ritmo ")),
    ("es", (" que ", " los ", " las ", " una ", " por ", " para ", " con ", " pero ", " como ", " todo ", " nada ", " eres ", " noche ")),
    ("de", (" ich ", " und ", " die ", " der ", " das ", " nicht ", " mit ", " ist ", " ein ", " für ", " wir ", " mein ", " feuer ")),
    ("en", (" the ", " and ", " you ", " that ", " with ", " this ", " for ", " are ", " have ", " from ", " your ", " all ", " through ")),
)

_CAL_ACTIVITY_RULES: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("sport", ("sport", "gym", "workout", "train", "run", "cardio", "lift", "muscu")),
    ("work_coding", ("code", "coding", "dev", "build", "work", "travail", "focus", "deep work", "study")),
    ("meeting_focus", ("meeting", "call", "sync", "standup", "réunion", "review")),
    ("social_evening", ("dinner", "party", "soiree", "soirée", "drink", "friends", "date")),
)

_TITLE_CONTEXT_HINTS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("brazilian phonk", ("montagem", "automotivo", "funk brasileiro", "batidao", "batidão", "ritmo brasileiro")),
    ("phonk", ("phonk", "drift", "cowbell", "memphis")),
    ("power metal", ("dinosaur", "warriors", "glory", "victorious", "kingdom", "valhalla", "symphonic", "crusade")),
    ("metalcore", ("moshpit", "through the ashes", "wrong side", "death punch", "goddamn")),
    ("nightcore", ("nightcore", "sped up")),
)


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def _parse_dt(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def _daypart(local_dt: datetime) -> str:
    hour = local_dt.hour
    if 5 <= hour < 12:
        return "matin"
    if 12 <= hour < 18:
        return "apres-midi"
    if 18 <= hour < 23:
        return "soiree"
    return "nuit"


def _macro_family(genre: str) -> str:
    low = genre.casefold()
    for family, tokens in MACRO_GENRE_RULES:
        if any(tok in low for tok in tokens):
            return family
    return "Other / Experimental"


def _playlist_archetype(name: str, genres: list[str], avg_dur: float) -> str:
    low = name.casefold()
    for label, tokens in PLAYLIST_ARCHETYPE_RULES:
        if any(tok in low for tok in tokens):
            return label
    gtxt = " ".join(genres).casefold()
    if any(t in gtxt for t in ("phonk", "montagem", "hardstyle")) or (avg_dur and avg_dur < 140):
        return "High-Intensity / Drift"
    if any(t in gtxt for t in ("metal", "rock", "industrial")):
        return "Heavy / Adrenaline"
    if any(t in gtxt for t in ("soundtrack", "orchestral", "ambient")):
        return "Atmospheric / Focus"
    return "Curated Mix"


def _set_job(**fields: Any) -> None:
    with _job_lock:
        _job_state.update(fields)


def get_fetch_status() -> dict[str, Any]:
    with _job_lock:
        return dict(_job_state)


def _load_raw() -> dict[str, Any]:
    raw = music._load(RAW_FILE, {})
    return raw if isinstance(raw, dict) else {}


def _save_raw(raw: dict[str, Any]) -> None:
    music._write(RAW_FILE, raw)


def _load_analysis() -> dict[str, Any]:
    doc = music._load(ANALYSIS_FILE, {})
    return doc if isinstance(doc, dict) else {}


def _save_analysis(doc: dict[str, Any]) -> None:
    music._write(ANALYSIS_FILE, doc)


def _clean_bpm_range(raw: Any) -> dict[str, int | None]:
    if not isinstance(raw, dict):
        return {"min": None, "max": None}
    lo = raw.get("min")
    hi = raw.get("max")
    out_lo = int(lo) if isinstance(lo, (int, float)) and 40 <= int(lo) <= 240 else None
    out_hi = int(hi) if isinstance(hi, (int, float)) and 40 <= int(hi) <= 240 else None
    if out_lo is not None and out_hi is not None and out_lo > out_hi:
        out_lo, out_hi = out_hi, out_lo
    return {"min": out_lo, "max": out_hi}


def _clean_mood_rules(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    out: dict[str, str] = {}
    for k in MOOD_RULE_KEYS:
        val = raw.get(k)
        if isinstance(val, str) and val.strip():
            out[k] = val.strip()[:240]
    return out


def get_overrides() -> dict[str, Any]:
    """Master's explicit directives, boosts, mood rules, targets, and editable lists."""
    doc = music._load(OVERRIDES_FILE, {})
    if not isinstance(doc, dict):
        doc = {}
    profile = music.get_profile()
    taste = music.get_taste()
    nov = doc.get("novelty_target")
    novelty_target = round(float(nov), 2) if isinstance(nov, (int, float)) and 0.15 <= float(nov) <= 0.90 else None
    return {
        "custom_notes": str(doc.get("custom_notes") or "")[:2000],
        "boosted_artists": [str(x) for x in (doc.get("boosted_artists") or []) if isinstance(x, str) and x.strip()][:50],
        "boosted_genres": [str(x) for x in (doc.get("boosted_genres") or []) if isinstance(x, str) and x.strip()][:50],
        "pinned_tracks": [str(x) for x in (doc.get("pinned_tracks") or []) if isinstance(x, str) and x.strip()][:40],
        "mood_rules_override": _clean_mood_rules(doc.get("mood_rules_override")),
        "target_bpm_range": _clean_bpm_range(doc.get("target_bpm_range")),
        "novelty_target": novelty_target,
        "language_preferences": [str(x) for x in (doc.get("language_preferences") or []) if isinstance(x, str) and x.strip()][:12],
        "context_tags": [str(x) for x in (doc.get("context_tags") or []) if isinstance(x, str) and x.strip()][:24],
        "favorite_artists": list(profile.get("favorite_artists") or []),
        "preferred_genres": list(profile.get("preferred_genres") or []),
        "musical_patterns": list(profile.get("musical_patterns") or []),
        "banned_artists": list(taste.get("banned_artists") or []),
        "updated_utc": doc.get("updated_utc"),
    }


def save_overrides(body: dict[str, Any]) -> dict[str, Any]:
    """Persist Master's edits/additions from the Profil tab and re-analyze local dossier."""
    if not isinstance(body, dict):
        raise music.MusicError("Corps JSON invalide")

    pref_updates: dict[str, Any] = {}
    for key in music.MUSIC_KEYS:
        if key in body:
            pref_updates[key] = body[key]
    if pref_updates:
        music.update_preferences(pref_updates)

    if "banned_artists" in body:
        new_bans = music._clean_list(body["banned_artists"], "Artistes bannis", 200)
        old_bans = list(music.get_taste().get("banned_artists") or [])
        old_keys = {x.casefold() for x in old_bans}
        new_keys = {x.casefold() for x in new_bans}
        for name in new_bans:
            if name.casefold() not in old_keys:
                music.update_taste({"ban": name})
        for name in old_bans:
            if name.casefold() not in new_keys:
                music.update_taste({"unban": name})

    doc = music._load(OVERRIDES_FILE, {})
    if not isinstance(doc, dict):
        doc = {}
    if "custom_notes" in body:
        doc["custom_notes"] = str(body["custom_notes"] or "").strip()[:2000]
    if "boosted_artists" in body:
        doc["boosted_artists"] = music._clean_list(body["boosted_artists"], "Artistes mis en avant", 50)
    if "boosted_genres" in body:
        doc["boosted_genres"] = music._clean_list(body["boosted_genres"], "Genres mis en avant", 50)
    if "pinned_tracks" in body:
        doc["pinned_tracks"] = music._clean_list(body["pinned_tracks"], "Titres de référence", 40)
    if "language_preferences" in body:
        doc["language_preferences"] = music._clean_list(body["language_preferences"], "Langues préférées", 12)
    if "context_tags" in body:
        doc["context_tags"] = music._clean_list(body["context_tags"], "Contextes d'écoute", 24)
    if "mood_rules_override" in body:
        doc["mood_rules_override"] = _clean_mood_rules(body["mood_rules_override"])
    if "target_bpm_range" in body:
        doc["target_bpm_range"] = _clean_bpm_range(body["target_bpm_range"])
    if "novelty_target" in body:
        raw_nov = body["novelty_target"]
        if raw_nov is None or raw_nov == "":
            doc["novelty_target"] = None
        else:
            try:
                val = float(raw_nov)
            except (TypeError, ValueError) as exc:
                raise music.MusicError("Cible de familiarité invalide") from exc
            doc["novelty_target"] = round(max(0.15, min(0.90, val)), 2)

    doc["version"] = 2
    doc["updated_utc"] = _utcnow()
    music._write(OVERRIDES_FILE, doc)

    # Re-analyze deterministically so dossier reflects edits immediately
    if music.get_taste().get("history_sharing", True):
        analyze_profile()
    return {"ok": True, "overrides": get_overrides(), "analysis": _load_analysis() or None}


# ---------------------------------------------------------------------------
# 1. Local Multi-Store Loaders & Public Metadata Enrichment
# ---------------------------------------------------------------------------

def _collect_journal_plays(now: datetime) -> tuple[dict[str, Any], list[tuple[date, datetime, dict[str, Any]]]]:
    """Load journal index and up to 12 recent months of local plays."""
    try:
        import hq_music_journal as journal
        index = music._load(journal.INDEX_FILE, {"artists": {}, "tracks": {}})
        plays: list[tuple[date, datetime, dict[str, Any]]] = []
        for month in journal.months()[:12]:
            for row in journal.plays(month):
                dt = _parse_dt(row.get("t"))
                if dt is None:
                    continue
                local = dt.astimezone()
                plays.append((local.date(), local, row))
        plays.sort(key=lambda x: x[1])
        return index, plays
    except Exception:  # noqa: BLE001
        return {"artists": {}, "tracks": {}}, []


def _collect_dig_cache() -> dict[str, list[dict[str, Any]]]:
    """Read cached Spotify pools already dug by DJ Musica (liked, classics, deep_cuts, playlists, followed, artist_dig)."""
    doc = music._load("dj-dig-cache.json", {})
    if not isinstance(doc, dict):
        return {}
    out: dict[str, list[dict[str, Any]]] = {}
    for pool_name, entry in doc.items():
        if isinstance(entry, dict) and isinstance(entry.get("rows"), list):
            rows = [r for r in entry["rows"] if isinstance(r, dict) and r.get("name")]
            if rows:
                out[str(pool_name)] = rows
    return out


def _collect_tournaments() -> dict[str, Any]:
    """Aggregate revealed-preference match wins, finals, champions, and rivalry across tournament halls."""
    halls: list[tuple[str, dict[str, Any]]] = []
    try:
        import hq_music_dj_hall as hall
        kinds = getattr(hall, "KINDS", ("games",))
    except Exception:  # noqa: BLE001
        kinds = ("games", "decade", "artists", "albums", "library", "daily")

    for kind in kinds:
        fname = "tournament-hall.json" if kind == "games" else f"tournament-hall-{kind}.json"
        doc = music._load(fname, {})
        if isinstance(doc, dict) and (doc.get("songs") or doc.get("champions") or doc.get("played")):
            halls.append((kind, doc))

    total_played = 0
    songs_out: dict[str, dict[str, Any]] = {}
    artists_out: dict[str, dict[str, Any]] = {}
    champions: list[dict[str, Any]] = []
    rivalry_wins_master = 0
    rivalry_wins_musica = 0

    for kind, doc in halls:
        total_played += int(doc.get("played") or 0)
        rival = doc.get("rivalry") if isinstance(doc.get("rivalry"), dict) else {}
        rivalry_wins_master += int(rival.get("master") or 0)
        rivalry_wins_musica += int(rival.get("musica") or 0)
        for ch in doc.get("champions") or []:
            if isinstance(ch, dict) and ch.get("name"):
                champions.append({
                    "kind": kind,
                    "name": ch.get("name"),
                    "artist": ch.get("artist") or "",
                    "angle": ch.get("angle") or "",
                    "at": ch.get("at"),
                })
        for s in (doc.get("songs") or {}).values():
            if not isinstance(s, dict) or not s.get("name"):
                continue
            wins = int(s.get("wins") or 0)
            losses = int(s.get("losses") or 0)
            titles = int(s.get("titles") or 0)
            finals = int(s.get("finals") or 0)
            if wins + losses + titles + finals == 0:
                continue
            key = f"{str(s.get('artist') or '').casefold()}||{str(s.get('name') or '').casefold()}"
            prev = songs_out.get(key) or {
                "name": str(s.get("name") or ""),
                "artist": str(s.get("artist") or ""),
                "uri": s.get("uri"),
                "wins": 0, "losses": 0, "titles": 0, "finals": 0,
            }
            prev["wins"] += wins
            prev["losses"] += losses
            prev["titles"] += titles
            prev["finals"] += finals
            songs_out[key] = prev

        for a in (doc.get("artists") or {}).values():
            if not isinstance(a, dict) or not a.get("name"):
                continue
            ak = str(a["name"]).strip().casefold()
            prev_a = artists_out.get(ak) or {"name": str(a["name"]).strip(), "finals": 0, "titles": 0, "wins": 0, "losses": 0}
            prev_a["finals"] += int(a.get("finals") or 0)
            prev_a["titles"] += int(a.get("titles") or 0)
            artists_out[ak] = prev_a

    for s in songs_out.values():
        ak = str(s["artist"]).strip().casefold()
        if ak:
            rec_a = artists_out.setdefault(ak, {"name": s["artist"], "finals": 0, "titles": 0, "wins": 0, "losses": 0})
            rec_a["wins"] += s["wins"]
            rec_a["losses"] += s["losses"]

    top_songs = sorted(
        songs_out.values(),
        key=lambda x: (-(x["titles"] * 3 + x["wins"] - 0.5 * x["losses"]), x["name"]),
    )[:12]
    top_artists = sorted(
        artists_out.values(),
        key=lambda x: (-(x["titles"] * 4 + x["finals"] * 2 + x["wins"] - 0.5 * x["losses"]), x["name"]),
    )[:12]
    return {
        "tournaments_played": total_played,
        "songs": songs_out,
        "artists": artists_out,
        "top_songs": top_songs,
        "top_artists": top_artists,
        "recent_champions": champions[-8:],
        "rivalry": {"master_wins": rivalry_wins_master, "musica_wins": rivalry_wins_musica},
    }


def _collect_radar() -> list[dict[str, Any]]:
    doc = music._load("radar.json", {})
    items = doc.get("items") if isinstance(doc, dict) else []
    return [r for r in (items or []) if isinstance(r, dict) and r.get("name")]


def _http_get_json(url: str, *, timeout: float = 1.4, headers: dict[str, str] | None = None) -> dict[str, Any] | None:
    req = Request(url, headers=headers or {"User-Agent": "TransfertHQ-Musica/1.0 (local-music-profiler)"})
    try:
        with urlopen(req, timeout=timeout) as resp:  # noqa: S310
            raw = resp.read().decode("utf-8", errors="replace")
        data = json.loads(raw)
        return data if isinstance(data, dict) else None
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError, ValueError, OSError):
        return None


def _fetch_public_artist_meta(name: str) -> dict[str, Any] | None:
    """Zero-key public artist metadata fallback via MusicBrainz -> iTunes Search API."""
    clean = " ".join(str(name or "").split()).strip()
    if not clean:
        return None
    genres: list[str] = []
    country: str | None = None
    artist_type: str | None = None

    # 1. MusicBrainz community tags + country/type
    mb_q = urlencode({"query": f'artist:"{clean}"', "fmt": "json", "limit": "3"})
    mb = _http_get_json(f"https://musicbrainz.org/ws/2/artist/?{mb_q}", timeout=1.4)
    if isinstance(mb, dict):
        target_cf = clean.casefold()
        best = None
        for cand in mb.get("artists") or []:
            if not isinstance(cand, dict):
                continue
            cname = str(cand.get("name") or "").strip().casefold()
            score = int(cand.get("score") or 0)
            if cname == target_cf and score >= 85:
                best = cand
                break
            if best is None and score >= 95:
                best = cand
        if isinstance(best, dict):
            country = str(best.get("country") or (best.get("area") or {}).get("name") or "").strip()[:40] or None
            artist_type = str(best.get("type") or "").strip()[:32] or None
            tags = [
                (int(t.get("count") or 0), str(t.get("name") or "").strip().lower())
                for t in (best.get("tags") or [])
                if isinstance(t, dict) and t.get("name")
            ]
            tags.sort(key=lambda x: -x[0])
            for cnt, tag_name in tags:
                if cnt >= 1 and tag_name and tag_name not in {"seen live", "favorites"}:
                    if tag_name not in genres:
                        genres.append(tag_name)
                    if len(genres) >= 6:
                        break

    # 2. iTunes Search API fallback for primaryGenreName when MusicBrainz lacks tags
    if not genres:
        it_q = urlencode({"term": clean, "entity": "musicArtist", "limit": "3"})
        it = _http_get_json(f"https://itunes.apple.com/search?{it_q}", timeout=1.2)
        if isinstance(it, dict):
            target_cf = clean.casefold()
            for res in it.get("results") or []:
                if not isinstance(res, dict):
                    continue
                rname = str(res.get("artistName") or "").strip().casefold()
                if rname == target_cf or len(it.get("results") or []) == 1:
                    pg = str(res.get("primaryGenreName") or "").strip().lower()
                    if pg and pg not in {"music", "musique"}:
                        genres.append(pg)
                    break

    if not genres and not country and not artist_type:
        return None
    return {
        "name": clean,
        "genres": genres[:6],
        "country": country,
        "artist_type": artist_type,
    }


def _enrich_artists_public(
    artist_names: list[str],
    artist_cache: dict[str, Any],
    now: float,
    *,
    budget: int = MAX_PUBLIC_ENRICH,
) -> int:
    """Enrich top un-genred artists via public MusicBrainz/iTunes APIs inside strict wall-time budget."""
    known_with_genres: set[str] = set()
    fresh_public: set[str] = set()
    for v in artist_cache.values():
        if not isinstance(v, dict) or not v.get("name"):
            continue
        cf = str(v["name"]).strip().casefold()
        if v.get("genres"):
            known_with_genres.add(cf)
        if now - float(v.get("public_enriched_at") or 0) < PUBLIC_CACHE_TTL_SEC:
            fresh_public.add(cf)

    looked_up = 0
    start_ts = time.monotonic()
    for name in artist_names:
        if looked_up >= budget or (time.monotonic() - start_ts) >= PUBLIC_ENRICH_BUDGET_SEC:
            break
        clean = " ".join(str(name or "").split()).strip()
        if not clean:
            continue
        cf = clean.casefold()
        if cf in known_with_genres or cf in fresh_public:
            continue
        looked_up += 1
        meta = _fetch_public_artist_meta(clean)
        fresh_public.add(cf)
        existing_key = next(
            (k for k, v in artist_cache.items()
             if isinstance(v, dict) and str(v.get("name") or "").strip().casefold() == cf),
            f"pub:{cf}",
        )
        prev = artist_cache.get(existing_key) if isinstance(artist_cache.get(existing_key), dict) else {}
        if meta:
            genres = meta.get("genres") or prev.get("genres") or []
            artist_cache[existing_key] = {
                "id": prev.get("id"),
                "name": prev.get("name") or clean,
                "genres": genres,
                "popularity": prev.get("popularity"),
                "followers": prev.get("followers"),
                "country": meta.get("country") or prev.get("country"),
                "artist_type": meta.get("artist_type") or prev.get("artist_type"),
                "source_meta": prev.get("source_meta") or "public",
                "cached_at": prev.get("cached_at") or now,
                "public_enriched_at": now,
            }
            if genres:
                known_with_genres.add(cf)
        else:
            # Negative cache briefly (reuse public_enriched_at) so offline artists aren't hammered daily
            artist_cache[existing_key] = {
                "id": prev.get("id"),
                "name": prev.get("name") or clean,
                "genres": prev.get("genres") or [],
                "popularity": prev.get("popularity"),
                "followers": prev.get("followers"),
                "country": prev.get("country"),
                "artist_type": prev.get("artist_type"),
                "cached_at": prev.get("cached_at") or now,
                "public_enriched_at": now,
            }
    return looked_up


# ---------------------------------------------------------------------------
# 2. Deep Multi-Source Fetcher
# ---------------------------------------------------------------------------

def fetch_raw_profile(
    *,
    deep: bool = True,
    force: bool = False,
    public_enrich: bool = True,
    progress_cb: Callable[[str, int, str], None] | None = None,
) -> dict[str, Any]:
    """Fetch deep Spotify catalog, playlists, public artist genres, and LRCLIB lyrics.

    Respects ``history_sharing`` and Spotify rate limits (``retry_429=False``).
    Even when Spotify is disconnected, deep local + public MusicBrainz/iTunes + LRCLIB
    enrichment runs so the Master's dossier has real genres, origins, and lyrical data.
    """
    import hq_spotify as spotify

    def report(stage: str, pct: int, label: str) -> None:
        if progress_cb is not None:
            progress_cb(stage, pct, label)

    if not music.get_taste().get("history_sharing", True):
        return {"ok": False, "skipped": "history_sharing_disabled", "spotify": {}}

    existing = _load_raw()
    now = time.time()
    if (
        not force
        and existing.get("fetched_utc")
        and now - float(existing.get("checked") or 0) < RAW_TTL_SEC
        and not existing.get("partial")
    ):
        report("fetch_cached", 45, "Données brutes récentes en cache.")
        return existing

    prev_sp = existing.get("spotify") if isinstance(existing.get("spotify"), dict) else {}
    artist_cache: dict[str, Any] = dict(prev_sp.get("artist_cache") or {})
    artist_cache = {
        k: v for k, v in artist_cache.items()
        if isinstance(v, dict) and now - float(v.get("cached_at") or 0) < ARTIST_CACHE_TTL_SEC
    }

    sp_data: dict[str, Any] = {
        "top_artists": {},
        "top_tracks": {},
        "recent": [],
        "saved_tracks": [],
        "saved_albums": [],
        "followed_artists": [],
        "playlists": [],
        "artist_cache": artist_cache,
    }
    raw_out: dict[str, Any] = {
        "version": 2,
        "checked": now,
        "fetched_utc": _utcnow(),
        "partial": False,
        "retry_at": None,
        "spotify_connected": False,
        "spotify": sp_data,
    }

    try:
        sp_status = spotify.status()
    except Exception:  # noqa: BLE001
        sp_status = {"connected": False}

    rate_limited = False

    def safe_call(fn: Callable[[], Any]) -> Any:
        nonlocal rate_limited
        if rate_limited:
            return None
        try:
            return fn()
        except spotify.SpotifyError as exc:
            if exc.status == 429:
                rate_limited = True
                raw_out["partial"] = True
                raw_out["retry_at"] = time.time() + (exc.retry_after or 60)
            return None

    def cache_artist(a: dict[str, Any]) -> None:
        if not isinstance(a, dict) or not a.get("name"):
            return
        key = str(a.get("id") or a["name"].casefold())
        prev = artist_cache.get(key) if isinstance(artist_cache.get(key), dict) else {}
        genres = a.get("genres") if (isinstance(a.get("genres"), list) and a.get("genres")) else (prev.get("genres") or [])
        artist_cache[key] = {
            "id": a.get("id") or prev.get("id"),
            "name": a["name"],
            "genres": genres,
            "popularity": a.get("popularity") if isinstance(a.get("popularity"), int) else prev.get("popularity"),
            "followers": a.get("followers") if isinstance(a.get("followers"), int) else prev.get("followers"),
            "country": prev.get("country"),
            "artist_type": prev.get("artist_type"),
            "source_meta": "spotify" if a.get("genres") else prev.get("source_meta"),
            "cached_at": now,
            "public_enriched_at": prev.get("public_enriched_at"),
        }

    if sp_status.get("connected"):
        raw_out["spotify_connected"] = True

        # Step 1: Top Artists & Top Tracks (3 horizons, limit=50)
        report("fetch_tops", 10, "Récupération des tops artistes et titres (court, moyen, long terme)…")
        for period in spotify.TIME_RANGES:
            res_a = safe_call(lambda p=period: spotify.top_artists(p, limit=50, retry_429=False))
            if isinstance(res_a, dict):
                rows_a = res_a.get("artists") or []
                sp_data["top_artists"][period] = rows_a
                for a in rows_a:
                    cache_artist(a)
            res_t = safe_call(lambda p=period: spotify.top_tracks(p, limit=50, retry_429=False))
            if isinstance(res_t, dict):
                sp_data["top_tracks"][period] = res_t.get("tracks") or []

        # Step 2: Recently played
        report("fetch_recent", 18, "Récupération des écoutes récentes…")
        res_rec = safe_call(lambda: spotify.recently_played(50, retry_429=False))
        if isinstance(res_rec, dict):
            sp_data["recent"] = res_rec.get("tracks") or []

        if deep and not rate_limited:
            # Step 3: Saved Tracks (paginated up to MAX_SAVED_TRACKS)
            report("fetch_library", 25, "Scan profond des titres aimés et albums sauvegardés…")
            offset = 0
            while len(sp_data["saved_tracks"]) < MAX_SAVED_TRACKS and not rate_limited:
                page = safe_call(lambda off=offset: spotify.saved_tracks(50, off, retry_429=False))
                if not isinstance(page, dict):
                    break
                items = page.get("tracks") or []
                if not items:
                    break
                sp_data["saved_tracks"].extend(items)
                offset += len(items)
                if not page.get("next"):
                    break
            sp_data["saved_tracks"] = sp_data["saved_tracks"][:MAX_SAVED_TRACKS]

            # Saved Albums
            offset = 0
            while len(sp_data["saved_albums"]) < MAX_SAVED_ALBUMS and not rate_limited:
                page = safe_call(lambda off=offset: spotify.saved_albums(50, off, retry_429=False))
                if not isinstance(page, dict):
                    break
                items = page.get("albums") or []
                if not items:
                    break
                sp_data["saved_albums"].extend(items)
                offset += len(items)
                if not page.get("next"):
                    break
            sp_data["saved_albums"] = sp_data["saved_albums"][:MAX_SAVED_ALBUMS]

            # Followed Artists (up to 4 pages / 200 artists)
            after: str | None = None
            for _ in range(4):
                if rate_limited:
                    break
                page = safe_call(lambda af=after: spotify.followed_artists(50, af, retry_429=False))
                if not isinstance(page, dict):
                    break
                items = page.get("artists") or []
                sp_data["followed_artists"].extend(items)
                for a in items:
                    cache_artist(a)
                after = page.get("after")
                if not after:
                    break

            # Step 4: Owned / Collaborative Playlists
            report("fetch_playlists", 35, "Scan approfondi des playlists du Maître…")
            skip_uri = spotify.playback_playlist_uri()
            pl_list = safe_call(lambda: spotify.list_playlists(limit=50))
            if isinstance(pl_list, dict):
                candidates = [
                    p for p in (pl_list.get("items") or [])
                    if isinstance(p, dict)
                    and p.get("id")
                    and p.get("uri") != skip_uri
                    and not str(p.get("name") or "").startswith("Musica ·")
                ]
                for pl in candidates[:MAX_PLAYLISTS_FETCH]:
                    if rate_limited:
                        break
                    tracks = safe_call(lambda pid=pl["id"]: spotify.collect_playlist_tracks(pid, max_tracks=MAX_PLAYLIST_TRACKS))
                    if isinstance(tracks, list) and tracks:
                        sp_data["playlists"].append({
                            "id": pl.get("id"),
                            "uri": pl.get("uri"),
                            "name": pl.get("name") or "Playlist",
                            "tracks_total": pl.get("tracks_total") or len(tracks),
                            "tracks": tracks,
                        })

            # Step 5: Spotify Artist Batch Genre Enrichment (up to MAX_ARTIST_ENRICH)
            report("fetch_genres", 45, "Enrichissement Spotify des genres et popularités…")
            missing_ids: list[str] = []
            seen_ids: set[str] = set()
            pl_tracks_all = [t for pl in sp_data["playlists"] for t in (pl.get("tracks") or [])]
            candidate_tracks = (
                (sp_data["top_tracks"].get("short") or [])
                + (sp_data["top_tracks"].get("medium") or [])
                + (sp_data["top_tracks"].get("long") or [])
                + sp_data["saved_tracks"][:600]
                + sp_data["recent"]
                + pl_tracks_all[:600]
            )
            for tr in candidate_tracks:
                for aid in tr.get("artist_ids") or []:
                    if aid not in seen_ids:
                        seen_ids.add(aid)
                        cached = artist_cache.get(aid)
                        if not isinstance(cached, dict) or not cached.get("genres"):
                            missing_ids.append(aid)
            if missing_ids and not rate_limited:
                for start_i in range(0, min(len(missing_ids), MAX_ARTIST_ENRICH), 50):
                    if rate_limited:
                        break
                    chunk = missing_ids[start_i:start_i + 50]
                    enriched = safe_call(lambda ids=chunk: spotify.get_artists(ids, retry_429=False))
                    if isinstance(enriched, list) and enriched:
                        for a in enriched:
                            cache_artist(a)
                    elif not rate_limited:
                        for aid in chunk[:10]:
                            if rate_limited:
                                break
                            single = safe_call(lambda i=aid: spotify.get_artist(i, retry_429=False))
                            if isinstance(single, dict) and isinstance(single.get("artist"), dict):
                                cache_artist(single["artist"])
                        break

            # Step 6: Enrich un-genred local Journal & Dig Cache artists via Spotify search
            if not rate_limited:
                known_names = {
                    str(v.get("name") or "").strip().casefold()
                    for v in artist_cache.values()
                    if isinstance(v, dict) and v.get("genres")
                }
                local_candidates = _priority_local_artists()
                searched = 0
                for aname in local_candidates:
                    if searched >= MAX_JOURNAL_SEARCH_ENRICH or rate_limited:
                        break
                    if aname.casefold() in known_names:
                        continue
                    res = safe_call(lambda n=aname: spotify.search(spotify.field_query("artist", n), types="artist", limit=1, retry_429=False))
                    searched += 1
                    if isinstance(res, dict):
                        for item in (res.get("artists") or [])[:1]:
                            if isinstance(item, dict) and item.get("name"):
                                cache_artist(item)
                                known_names.add(item["name"].strip().casefold())
    else:
        # Keep any previously captured Spotify library snapshot intact if present
        for k in ("top_artists", "top_tracks", "recent", "saved_tracks", "saved_albums", "followed_artists", "playlists"):
            if prev_sp.get(k):
                sp_data[k] = prev_sp[k]
        raw_out["partial"] = True

    if deep:
        # Step 6b: Public MusicBrainz / iTunes enrichment for still-ungenred artists (works even when Spotify is offline)
        if public_enrich:
            report("fetch_public", 52, "Enrichissement multi-bases (MusicBrainz / iTunes) des artistes…")
            pub_candidates = _collect_un_genred_priority_names(sp_data, artist_cache)
            _enrich_artists_public(pub_candidates, artist_cache, now, budget=MAX_PUBLIC_ENRICH)

        # Step 7: Sample synced lyrics (LRCLIB) from Spotify + local Journal + Dig cache tracks
        report("fetch_lyrics", 58, "Échantillonnage des paroles (langues, thèmes et ton)…")
        lyrics_candidates = _collect_lyrics_candidates(sp_data)
        _fetch_lyrics_sample(lyrics_candidates)

    _save_raw(raw_out)
    return raw_out


def _priority_local_artists() -> list[str]:
    """Return local artists ranked by empirical importance (journal, DJ, dig cache, SMTC, radar)."""
    counts: Counter[str] = Counter()
    names: dict[str, str] = {}

    def bump(raw_name: Any, weight: int) -> None:
        clean = " ".join(str(raw_name or "").split()).strip()
        if not clean:
            return
        cf = clean.casefold()
        names.setdefault(cf, clean)
        counts[cf] += weight

    j_idx, _ = _collect_journal_plays(datetime.now(timezone.utc))
    for entry in (j_idx.get("artists") or {}).values():
        if isinstance(entry, dict) and entry.get("name"):
            bump(entry["name"], int(entry.get("count") or 1) * 3)

    smtc_doc = music._load("musica_play_history.json", {"items": []})
    for it in smtc_doc.get("items") or []:
        if isinstance(it, dict) and it.get("artist"):
            bump(it["artist"], int(it.get("play_count") or 1) * 2)

    dig_pools = _collect_dig_cache()
    for pool_name, rows in dig_pools.items():
        w = 3 if pool_name in {"liked", "classics", "playlists"} else 1
        for r in rows:
            for an in r.get("artists") or []:
                bump(an, w)

    for it in _collect_radar():
        for an in it.get("artists") or []:
            bump(an, 2)

    return [names[cf] for cf, _c in counts.most_common(60)]


def _collect_un_genred_priority_names(sp_data: dict[str, Any], artist_cache: dict[str, Any]) -> list[str]:
    known_genred = {
        str(v.get("name") or "").strip().casefold()
        for v in artist_cache.values()
        if isinstance(v, dict) and v.get("genres")
    }
    ordered: list[str] = []
    seen: set[str] = set()

    def push(name: Any) -> None:
        clean = " ".join(str(name or "").split()).strip()
        if not clean:
            return
        cf = clean.casefold()
        if cf in seen or cf in known_genred:
            return
        seen.add(cf)
        ordered.append(clean)

    for period in ("short", "medium", "long"):
        for a in (sp_data.get("top_artists") or {}).get(period) or []:
            if isinstance(a, dict):
                push(a.get("name"))
    for local_name in _priority_local_artists():
        push(local_name)
    for t in (sp_data.get("saved_tracks") or [])[:150]:
        for an in t.get("artists") or []:
            push(an)
    return ordered[:60]


def _collect_lyrics_candidates(sp_data: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()

    def push_track(title: Any, artist: Any, duration_ms: Any) -> None:
        t = " ".join(str(title or "").split()).strip()
        a = " ".join(str(artist or "").split()).strip()
        if not t or not a:
            return
        key = f"{a.casefold()}||{t.casefold()}"
        if key in seen:
            return
        seen.add(key)
        candidates.append({
            "name": t,
            "artists": [a],
            "duration_ms": int(duration_ms) if isinstance(duration_ms, (int, float)) and duration_ms > 1000 else 180000,
        })

    for t in (sp_data.get("top_tracks") or {}).get("short") or []:
        if isinstance(t, dict):
            push_track(t.get("name"), (t.get("artists") or [""])[0], t.get("duration_ms"))
    for t in (sp_data.get("top_tracks") or {}).get("medium") or []:
        if isinstance(t, dict):
            push_track(t.get("name"), (t.get("artists") or [""])[0], t.get("duration_ms"))

    # Also prioritize Master's most replayed local Journal tracks
    j_idx, _ = _collect_journal_plays(datetime.now(timezone.utc))
    j_tracks = sorted(
        (v for v in (j_idx.get("tracks") or {}).values() if isinstance(v, dict) and v.get("name")),
        key=lambda v: -int(v.get("count") or 0),
    )
    for jt in j_tracks[:20]:
        push_track(jt.get("name"), (jt.get("artists") or [""])[0], jt.get("duration_ms") or 180000)

    # Followed by Dig cache classics/liked & Spotify saved
    dig_pools = _collect_dig_cache()
    for pname in ("classics", "liked", "playlists"):
        for r in (dig_pools.get(pname) or [])[:12]:
            push_track(r.get("name"), (r.get("artists") or [""])[0], r.get("duration_ms"))
    for t in (sp_data.get("saved_tracks") or [])[:15]:
        if isinstance(t, dict):
            push_track(t.get("name"), (t.get("artists") or [""])[0], t.get("duration_ms"))

    return candidates[:45]


# ---------------------------------------------------------------------------
# 3. Specialized Layer Analyzers
# ---------------------------------------------------------------------------

def _strip_lrc_timestamps(lrc: str) -> str:
    return re.sub(r"\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]", " ", lrc or "").strip()


def _classify_text_lang_themes(text: str, title: str = "", genres: list[str] | None = None) -> tuple[str, list[str]]:
    combined = f" {text} {title} ".casefold()
    if any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in combined):
        lang = "ja"
    elif any("\uac00" <= ch <= "\ud7af" for ch in combined):
        lang = "ko"
    elif any("\u0400" <= ch <= "\u04ff" for ch in combined):
        lang = "ru"
    elif not text.strip():
        gtxt = " ".join(genres or []).casefold()
        tlow = f" {title} ".casefold()
        if any(t in gtxt for t in ("j-pop", "j-rock", "anime", "vocaloid")):
            lang = "ja"
        elif any(t in gtxt for t in ("k-pop", "k-rock")):
            lang = "ko"
        elif any(t in gtxt for t in ("brazilian", "funk brasileiro", "montagem")) or any(
            t in tlow for t in ("montagem", "automotivo", "ritmo", "vai ", "toma ")
        ):
            lang = "pt"
        elif any(t in gtxt for t in ("reggaeton", "latin", "bachata")):
            lang = "es"
        elif "french" in gtxt or "chanson" in gtxt or "frenchcore" in gtxt:
            lang = "fr"
        elif "neue deutsche" in gtxt or "german" in gtxt:
            lang = "de"
        else:
            lang = "en"
    else:
        padded = f" {combined} "
        best_lang, best_hits = "en", 0
        for code, words in _LANG_STOPWORDS:
            hits = sum(padded.count(w) for w in words)
            if hits > best_hits:
                best_lang, best_hits = code, hits
        lang = best_lang

    themes: list[str] = []
    for theme, kws in _LYRIC_THEMES:
        score = sum(1 for kw in kws if kw in combined)
        if score >= 2:
            themes.append(theme)
    return lang, themes


def _fetch_lyrics_sample(tracks: list[dict[str, Any]]) -> None:
    """Best-effort LRCLIB sampling for top tracks, cached for 60 days."""
    try:
        import hq_musica
    except Exception:  # noqa: BLE001
        return
    cache = music._load(LYRICS_CACHE_FILE, {"version": 1, "tracks": {}})
    entries = cache.get("tracks") if isinstance(cache.get("tracks"), dict) else {}
    now = time.time()
    entries = {
        k: v for k, v in entries.items()
        if isinstance(v, dict) and now - float(v.get("fetched_at") or 0) < LYRICS_TTL_SEC
    }
    fetched = 0
    seen: set[str] = set()
    start_ts = time.monotonic()
    for t in tracks:
        if fetched >= MAX_LYRICS_FETCH or (time.monotonic() - start_ts) >= PUBLIC_ENRICH_BUDGET_SEC:
            break
        if not isinstance(t, dict):
            continue
        title = str(t.get("name") or "").strip()
        artists = t.get("artists") or []
        artist = str(artists[0] if artists else "").strip()
        dur_ms = t.get("duration_ms")
        if not title or not artist or not isinstance(dur_ms, (int, float)) or dur_ms < 1000:
            continue
        key = f"{artist.casefold()}||{title.casefold()}"
        if key in seen or key in entries:
            continue
        seen.add(key)
        fetched += 1
        try:
            res = hq_musica.lookup_synced_lyrics({"title": title, "artist": artist, "duration": int(round(dur_ms / 1000.0))})
            lrc = str((res or {}).get("lrc") or "")
        except Exception:  # noqa: BLE001
            continue
        plain = _strip_lrc_timestamps(lrc)
        lang, themes = _classify_text_lang_themes(plain, title=title)
        words = [w for w in re.findall(r"[a-zA-ZÀ-ÿ']{3,}", plain.lower())]
        entries[key] = {
            "title": title,
            "artist": artist,
            "instrumental": not bool(plain),
            "language": "instrumental" if not plain else lang,
            "themes": themes,
            "word_count": len(words),
            "unique_words": len(set(words)),
            "fetched_at": now,
        }
    if fetched:
        music._write(LYRICS_CACHE_FILE, {"version": 1, "tracks": entries})


def _infer_context_genres(
    artist_key: str,
    tracks_for_artist: list[dict[str, Any]],
    playlists_for_artist: set[str],
) -> list[str]:
    """Conservative contextual genre inference ONLY when Spotify & public metadata yielded no genres."""
    inferred: list[str] = []
    seen: set[str] = set()

    def add(g: str) -> None:
        if g not in seen:
            seen.add(g)
            inferred.append(g)

    for pl_name in playlists_for_artist:
        low = pl_name.casefold()
        for fam, tokens in MACRO_GENRE_RULES:
            for tok in tokens:
                if tok in low:
                    add(tok)
                    break

    for tr in tracks_for_artist:
        tname = str(tr.get("name") or "")
        low = tname.casefold()
        for genre_lbl, kws in _TITLE_CONTEXT_HINTS:
            if any(k in low for k in kws):
                add(genre_lbl)
        if any("\u3040" <= ch <= "\u30ff" or "\u4e00" <= ch <= "\u9fff" for ch in tname):
            add("j-pop")
        elif any("\uac00" <= ch <= "\ud7af" for ch in tname):
            add("k-pop")

    return inferred[:4]


def _compute_session_flow(
    j_plays: list[tuple[date, datetime, dict[str, Any]]],
    artist_macro_map: dict[str, str],
) -> dict[str, Any]:
    """Segment plays into sessions and build directed artist/genre transition matrices."""
    if not j_plays:
        return {
            "session_count": 0,
            "avg_session_tracks": 0.0,
            "longest_session_tracks": 0,
            "avg_gap_minutes": None,
            "openers": [],
            "closers": [],
            "artist_transitions": [],
            "family_transitions": [],
            "opening_vs_closing_shift": {},
        }
    sessions: list[list[str]] = []
    cur: list[str] = []
    prev_dt: datetime | None = None
    in_session_gaps: list[float] = []
    for _d, local_dt, row in j_plays:
        lead = str((row.get("a") or [""])[0] or "").strip()
        if not lead:
            continue
        if prev_dt is not None:
            gap = (local_dt - prev_dt).total_seconds()
            if gap > LINK_GAP_SEC:
                if cur:
                    sessions.append(cur)
                cur = []
            elif gap >= 0:
                in_session_gaps.append(gap / 60.0)
        cur.append(lead)
        prev_dt = local_dt
    if cur:
        sessions.append(cur)

    openers: Counter[str] = Counter()
    closers: Counter[str] = Counter()
    opener_fams: Counter[str] = Counter()
    closer_fams: Counter[str] = Counter()
    art_trans: Counter[tuple[str, str]] = Counter()
    fam_trans: Counter[tuple[str, str]] = Counter()
    art_out: Counter[str] = Counter()
    fam_out: Counter[str] = Counter()

    for sess in sessions:
        openers[sess[0]] += 1
        closers[sess[-1]] += 1
        ofam = artist_macro_map.get(sess[0].casefold())
        cfam = artist_macro_map.get(sess[-1].casefold())
        if ofam:
            opener_fams[ofam] += 1
        if cfam:
            closer_fams[cfam] += 1
        for i in range(len(sess) - 1):
            a1, a2 = sess[i], sess[i + 1]
            if a1.casefold() != a2.casefold():
                art_trans[(a1, a2)] += 1
                art_out[a1] += 1
                f1 = artist_macro_map.get(a1.casefold())
                f2 = artist_macro_map.get(a2.casefold())
                if f1 and f2 and f1 != f2:
                    fam_trans[(f1, f2)] += 1
                    fam_out[f1] += 1

    lengths = [len(s) for s in sessions]
    return {
        "session_count": len(sessions),
        "avg_session_tracks": round(sum(lengths) / len(lengths), 1) if lengths else 0.0,
        "longest_session_tracks": max(lengths) if lengths else 0,
        "avg_gap_minutes": round(sum(in_session_gaps) / len(in_session_gaps), 1) if in_session_gaps else None,
        "openers": [{"artist": a, "count": c} for a, c in openers.most_common(8)],
        "closers": [{"artist": a, "count": c} for a, c in closers.most_common(8)],
        "artist_transitions": [
            {"from": a1, "to": a2, "count": c, "prob": round(c / max(1, art_out[a1]), 2)}
            for (a1, a2), c in art_trans.most_common(15)
        ],
        "family_transitions": [
            {"from": f1, "to": f2, "count": c, "prob": round(c / max(1, fam_out[f1]), 2)}
            for (f1, f2), c in fam_trans.most_common(12)
        ],
        "opening_vs_closing_shift": {
            "top_opening_families": [f for f, _c in opener_fams.most_common(3)],
            "top_closing_families": [f for f, _c in closer_fams.most_common(3)],
        },
    }


def _compute_lyrical_profile(
    track_pool: list[dict[str, Any]],
    artist_genres_map: dict[str, list[str]],
) -> dict[str, Any]:
    """Combine cached LRCLIB lyrics with track/genre script heuristics and lexical richness."""
    cache = music._load(LYRICS_CACHE_FILE, {"tracks": {}})
    entries = cache.get("tracks") if isinstance(cache.get("tracks"), dict) else {}
    lang_counts: Counter[str] = Counter()
    theme_counts: Counter[str] = Counter()
    theme_examples: dict[str, list[str]] = defaultdict(list)
    instrumental = 0
    cached_hits = 0
    ttr_values: list[float] = []

    for t in track_pool[:160]:
        if not isinstance(t, dict):
            continue
        title = str(t.get("name") or "").strip()
        artists = t.get("artists") or []
        artist = str(artists[0] if artists else "").strip()
        key = f"{artist.casefold()}||{title.casefold()}"
        if key in entries and isinstance(entries[key], dict):
            cached_hits += 1
            ent = entries[key]
            if ent.get("instrumental"):
                instrumental += 1
            lang_counts[str(ent.get("language") or "en")] += 1
            wc = int(ent.get("word_count") or 0)
            uw = int(ent.get("unique_words") or 0)
            if wc >= 15:
                ttr_values.append(uw / wc)
            for th in ent.get("themes") or []:
                theme_counts[th] += 1
                if len(theme_examples[th]) < 3 and title:
                    theme_examples[th].append(f"{artist} — {title}" if artist else title)
        else:
            genres = artist_genres_map.get(artist.casefold(), [])
            lang, themes = _classify_text_lang_themes("", title=title, genres=genres)
            lang_counts[lang] += 1
            for th in themes:
                theme_counts[th] += 1
                if len(theme_examples[th]) < 3 and title:
                    theme_examples[th].append(f"{artist} — {title}" if artist else title)

    total = sum(lang_counts.values()) or 1
    return {
        "lyrics_cached_tracks": cached_hits,
        "tracks_evaluated": sum(lang_counts.values()),
        "instrumental_pct": round(instrumental * 100.0 / max(1, cached_hits), 1) if cached_hits else None,
        "lexical_diversity": round(sum(ttr_values) / len(ttr_values), 3) if ttr_values else None,
        "languages": {k: round(v * 100.0 / total, 1) for k, v in lang_counts.most_common(8)},
        "top_themes": [
            {"theme": k, "count": v, "examples": theme_examples.get(k, [])}
            for k, v in theme_counts.most_common(6)
        ],
    }


def _compute_fatigue_profile(
    artists: dict[str, dict[str, Any]],
    cooling_artists: list[dict[str, Any]],
    banned_keys: set[str],
    track_ledger: dict[str, dict[str, Any]],
    feedback_rejects: list[dict[str, Any]],
) -> dict[str, Any]:
    """Separate temporary overplay fatigue (artist & track level) from true dislike/rejection."""
    overplay_fatigue: list[dict[str, Any]] = []
    true_dislikes: list[dict[str, Any]] = []

    for key, a in artists.items():
        if key in banned_keys or a["explicit_reject"] > 0:
            true_dislikes.append({
                "name": a["name"],
                "reason": "banned" if key in banned_keys else "explicit_reject",
                "dj_skipped": a["dj_skipped"],
            })
            continue
        historical_love = a["journal_plays"] + (3 if a["sp_long_score"] > 1.5 else 0) + a["saved_tracks"]
        if historical_love >= 5 and (a["dj_skipped"] >= 2 or (a["journal_plays"] >= 6 and a["journal_recent_14d"] == 0)):
            overplay_fatigue.append({
                "name": a["name"],
                "historical_plays": a["journal_plays"],
                "recent_14d": a["journal_recent_14d"],
                "dj_skipped": a["dj_skipped"],
                "recommended_rest_days": 14,
            })
        elif a["dj_skipped"] >= 3 and historical_love < 3:
            true_dislikes.append({
                "name": a["name"],
                "reason": "dj_skip_pattern",
                "dj_skipped": a["dj_skipped"],
            })

    track_burnout: list[dict[str, Any]] = []
    for tr in track_ledger.values():
        if tr["journal_plays"] >= 4 and tr["recent_14d"] == 0:
            track_burnout.append({
                "name": tr["name"],
                "artists": tr["artists"],
                "historical_plays": tr["journal_plays"],
                "recommended_rest_days": 14,
            })
    track_burnout.sort(key=lambda x: (-x["historical_plays"], x["name"]))
    overplay_fatigue.sort(key=lambda x: (-x["dj_skipped"], -x["historical_plays"]))
    true_dislikes.sort(key=lambda x: (-x["dj_skipped"], x["name"]))
    return {
        "overplay_fatigue": overplay_fatigue[:12],
        "track_burnout": track_burnout[:10],
        "true_dislikes": true_dislikes[:15],
        "track_feedback_rejects": feedback_rejects[:15],
    }


def _compute_calendar_correlation(
    j_plays: list[tuple[date, datetime, dict[str, Any]]],
    artist_macro_map: dict[str, str],
    now: datetime,
) -> dict[str, Any]:
    """Correlate journal play timestamps against read-only calendar events and unscheduled baseline."""
    if music._calendar is None or not j_plays:
        return {"available": False, "matched_plays": 0, "unscheduled_plays": len(j_plays), "activities": {}}
    try:
        start = now - timedelta(days=30)
        events = music._calendar(start, now) or []
    except Exception:  # noqa: BLE001
        return {"available": False, "matched_plays": 0, "unscheduled_plays": len(j_plays), "activities": {}}

    windows: list[tuple[datetime, datetime, str]] = []
    for ev in events:
        if not isinstance(ev, dict) or ev.get("all_day"):
            continue
        s_dt = _parse_dt(ev.get("start"))
        e_dt = _parse_dt(ev.get("end") or ev.get("start"))
        if s_dt is None or e_dt is None:
            continue
        s_dt = s_dt - timedelta(minutes=10)
        e_dt = e_dt + timedelta(minutes=10)
        txt = f"{ev.get('title') or ''} {ev.get('category') or ''}".casefold()
        act = "other"
        for label, tokens in _CAL_ACTIVITY_RULES:
            if any(tok in txt for tok in tokens):
                act = label
                break
        windows.append((s_dt.astimezone(timezone.utc), e_dt.astimezone(timezone.utc), act))

    if not windows:
        return {"available": True, "matched_plays": 0, "unscheduled_plays": len(j_plays), "activities": {}}

    act_artists: dict[str, Counter[str]] = defaultdict(Counter)
    act_fams: dict[str, Counter[str]] = defaultdict(Counter)
    act_plays: Counter[str] = Counter()
    free_fams: Counter[str] = Counter()
    matched = 0
    unmatched = 0

    for _d, local_dt, row in j_plays:
        utc_dt = local_dt.astimezone(timezone.utc)
        hit = False
        for s_dt, e_dt, act in windows:
            if s_dt <= utc_dt <= e_dt:
                hit = True
                matched += 1
                act_plays[act] += 1
                for aname in row.get("a") or []:
                    if isinstance(aname, str) and aname.strip():
                        act_artists[act][aname.strip()] += 1
                        fam = artist_macro_map.get(aname.strip().casefold())
                        if fam:
                            act_fams[act][fam] += 1
                break
        if not hit:
            unmatched += 1
            for aname in row.get("a") or []:
                if isinstance(aname, str) and aname.strip():
                    fam = artist_macro_map.get(aname.strip().casefold())
                    if fam:
                        free_fams[fam] += 1

    return {
        "available": True,
        "matched_plays": matched,
        "unscheduled_plays": unmatched,
        "unscheduled_top_families": [f for f, _c in free_fams.most_common(3)],
        "activities": {
            act: {
                "plays": cnt,
                "top_artists": [a for a, _c in act_artists[act].most_common(5)],
                "top_families": [f for f, _c in act_fams[act].most_common(3)],
            }
            for act, cnt in act_plays.most_common()
        },
    }


def _compute_novelty_profile(dj_state: dict[str, Any], taste: dict[str, Any], overrides: dict[str, Any]) -> dict[str, Any]:
    """Measure discovery conversion rate and optimal familiarity-to-novelty sweet spot."""
    try:
        discoveries = music.get_discoveries()
    except Exception:  # noqa: BLE001
        discoveries = []

    accepted = sum(1 for d in discoveries if isinstance(d, dict) and d.get("status") in {"liked", "saved"})
    rejected = sum(1 for d in discoveries if isinstance(d, dict) and d.get("status") in {"disliked", "dismissed"})
    pending = sum(1 for d in discoveries if isinstance(d, dict) and d.get("status") == "new")
    total_disc = accepted + rejected
    conversion_rate = round(accepted / total_disc, 3) if total_disc > 0 else None

    pools = dj_state.get("pool_stats") if isinstance(dj_state.get("pool_stats"), dict) else {}
    comfort_done, comfort_tot = 0, 0
    novel_done, novel_tot = 0, 0
    for pname, st in pools.items():
        if not isinstance(st, dict):
            continue
        d = int(st.get("done") or 0)
        s = int(st.get("skipped") or 0)
        if pname in {"classics", "liked", "playlists"}:
            comfort_done += d
            comfort_tot += d + s
        elif pname in {"discovery", "deep_cuts", "artist_dig", "radar", "followed"}:
            novel_done += d
            novel_tot += d + s

    comfort_rate = (comfort_done + 1) / (comfort_tot + 2)
    novel_rate = (novel_done + 1) / (novel_tot + 2)
    ratio = comfort_rate / max(0.05, comfort_rate + novel_rate)
    if conversion_rate is not None:
        ratio = 0.7 * ratio + 0.3 * (1.0 - conversion_rate)
    optimal_familiarity = round(max(0.25, min(0.88, ratio)), 2)

    manual_target = overrides.get("novelty_target")
    effective_target = manual_target if isinstance(manual_target, float) else optimal_familiarity

    if effective_target >= 0.68:
        label = "comfort_heavy"
    elif effective_target >= 0.48:
        label = "balanced_explorer"
    else:
        label = "novelty_hunter"

    return {
        "discovery_accepted": accepted,
        "discovery_rejected": rejected,
        "discovery_pending": pending,
        "discovery_conversion_rate": conversion_rate,
        "comfort_completion_rate": round(comfort_rate, 3),
        "novelty_completion_rate": round(novel_rate, 3),
        "optimal_familiarity": optimal_familiarity,
        "manual_target_familiarity": manual_target,
        "sweet_spot_label": label,
    }


def _compute_weekly_momentum(
    j_plays: list[tuple[date, datetime, dict[str, Any]]],
    j_artists_idx: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    """Compare last 7d vs prior 7d journal momentum + newly arrived artists in last 14d."""
    cut_7d = now - timedelta(days=7)
    cut_14d = now - timedelta(days=14)
    recent_counts: Counter[str] = Counter()
    prior_counts: Counter[str] = Counter()
    display_names: dict[str, str] = {}
    recent_total = 0
    prior_total = 0

    for _d, local_dt, row in j_plays:
        utc_dt = local_dt.astimezone(timezone.utc)
        arts = [str(a).strip() for a in (row.get("a") or []) if isinstance(a, str) and a.strip()]
        if utc_dt >= cut_7d:
            recent_total += 1
            for a in arts:
                cf = a.casefold()
                display_names.setdefault(cf, a)
                recent_counts[cf] += 1
        elif utc_dt >= cut_14d:
            prior_total += 1
            for a in arts:
                cf = a.casefold()
                display_names.setdefault(cf, a)
                prior_counts[cf] += 1

    accelerating: list[dict[str, Any]] = []
    cooling: list[dict[str, Any]] = []
    for cf in set(recent_counts) | set(prior_counts):
        r = recent_counts[cf]
        p = prior_counts[cf]
        delta = r - p
        if delta >= 2 or (r >= 2 and p == 0):
            accelerating.append({"artist": display_names[cf], "last_7d": r, "prior_7d": p, "delta": delta})
        elif delta <= -2:
            cooling.append({"artist": display_names[cf], "last_7d": r, "prior_7d": p, "delta": delta})

    accelerating.sort(key=lambda x: (-x["delta"], -x["last_7d"], x["artist"]))
    cooling.sort(key=lambda x: (x["delta"], -x["prior_7d"], x["artist"]))

    new_arrivals: list[tuple[int, str]] = []
    for entry in j_artists_idx.values():
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        f_dt = _parse_dt(entry.get("first"))
        if f_dt and f_dt >= cut_14d:
            new_arrivals.append((int(entry.get("count") or 1), str(entry["name"])))
    new_arrivals.sort(key=lambda x: (-x[0], x[1]))

    vel_delta = None
    if prior_total > 0:
        vel_delta = round((recent_total - prior_total) * 100.0 / prior_total, 1)

    return {
        "plays_last_7d": recent_total,
        "plays_prior_7d": prior_total,
        "velocity_delta_pct": vel_delta,
        "accelerating_artists": accelerating[:8],
        "cooling_artists": cooling[:8],
        "new_arrivals_14d": [name for _c, name in new_arrivals[:10]],
    }


def _record_and_compute_drift(
    dossier: dict[str, Any],
    j_plays: list[tuple[date, datetime, dict[str, Any]]],
    j_artists_idx: dict[str, Any],
    now: datetime,
) -> dict[str, Any]:
    """Persist monthly taste snapshots and compute month-over-month + weekly momentum drift."""
    hist = music._load(HISTORY_FILE, {"version": 1, "snapshots": []})
    snaps = [s for s in (hist.get("snapshots") or []) if isinstance(s, dict) and s.get("month")]
    month_key = now.strftime("%Y-%m")
    fam_map = {
        f["family"]: f["share_pct"]
        for f in ((dossier.get("genre_profile") or {}).get("macro_families") or [])
        if isinstance(f, dict) and f.get("family")
    }
    top_names = [a["name"] for a in (dossier.get("artist_affinities") or [])[:15] if isinstance(a, dict)]
    current_snap = {
        "month": month_key,
        "captured_utc": _utcnow(),
        "macro_families": fam_map,
        "top_artists": top_names,
        "mainstream_index": (dossier.get("acoustic_fingerprint") or {}).get("mainstream_index"),
        "exploration_index": (dossier.get("acoustic_fingerprint") or {}).get("exploration_index"),
        "sonic_axes": {k: v.get("score") for k, v in (dossier.get("sonic_axes") or {}).items() if isinstance(v, dict)},
    }

    prev_snap = next((s for s in reversed(snaps) if s.get("month") != month_key), None)
    deltas: list[dict[str, Any]] = []
    new_top: list[str] = []
    dropped_top: list[str] = []
    if prev_snap:
        prev_fams = prev_snap.get("macro_families") or {}
        for fam in set(fam_map) | set(prev_fams):
            d = round(float(fam_map.get(fam, 0.0)) - float(prev_fams.get(fam, 0.0)), 1)
            if abs(d) >= 1.0:
                deltas.append({"family": fam, "delta_pct": d})
        deltas.sort(key=lambda x: -abs(x["delta_pct"]))
        prev_set = set(prev_snap.get("top_artists") or [])
        cur_set = set(top_names)
        new_top = [a for a in top_names if a not in prev_set][:6]
        dropped_top = [a for a in (prev_snap.get("top_artists") or []) if a not in cur_set][:6]

    snaps = [s for s in snaps if s.get("month") != month_key]
    snaps.append(current_snap)
    music._write(HISTORY_FILE, {"version": 1, "snapshots": snaps[-24:]})

    return {
        "snapshots_count": len(snaps),
        "compared_to_month": prev_snap.get("month") if prev_snap else None,
        "macro_family_deltas": deltas[:6],
        "new_top_artists": new_top,
        "dropped_top_artists": dropped_top,
        "weekly_momentum": _compute_weekly_momentum(j_plays, j_artists_idx, now),
    }


def _compute_sonic_axes(
    macro_families: list[dict[str, Any]],
    acoustic_fingerprint: dict[str, Any],
    circadian_profile: dict[str, Any],
    lyrical_profile: dict[str, Any],
    session_flow: dict[str, Any],
) -> dict[str, dict[str, Any]]:
    """Compute 6 calibrated 0-100 empirical sonic DNA axes with concrete driver explanations."""
    agg_w, adr_w, dark_w, theat_w, und_w = 0.0, 0.0, 0.0, 0.0, 0.0
    total_share = 0.0
    for f in macro_families:
        sh = float(f.get("share_pct") or 0.0)
        if sh <= 0:
            continue
        weights = _FAMILY_SONIC_WEIGHTS.get(f["family"], _FAMILY_SONIC_WEIGHTS["Other / Experimental"])
        agg_w += sh * weights[0]
        adr_w += sh * weights[1]
        dark_w += sh * weights[2]
        theat_w += sh * weights[3]
        und_w += sh * weights[4]
        total_share += sh

    if total_share > 0:
        agg_base = (agg_w / total_share) * 100.0
        adr_base = (adr_w / total_share) * 100.0
        dark_base = (dark_w / total_share) * 100.0
        theat_base = (theat_w / total_share) * 100.0
        und_base = (und_w / total_share) * 100.0
    else:
        agg_base = adr_base = dark_base = theat_base = und_base = 50.0

    bpm_prof = acoustic_fingerprint.get("bpm_profile") or {}
    med_bpm = float(bpm_prof.get("median_bpm") or 0.0)
    dur_prof = acoustic_fingerprint.get("duration_profile") or {}
    short_pct = float(dur_prof.get("short_under_150s_pct") or 0.0)
    epic_pct = float(dur_prof.get("epic_over_270s_pct") or 0.0)
    exp_ratio = float(acoustic_fingerprint.get("explicit_ratio") or 0.0)
    mainstream_idx = acoustic_fingerprint.get("mainstream_index")
    exp_idx = acoustic_fingerprint.get("exploration_index")

    themes = {t["theme"]: t["count"] for t in (lyrical_profile.get("top_themes") or []) if isinstance(t, dict)}
    dayparts = circadian_profile.get("dayparts") or {}
    night_pct = float((dayparts.get("nuit") or {}).get("share_pct") or 0.0)

    # Adrenaline blends genre energy + BPM + sprint cuts
    adr_score = adr_base
    if med_bpm >= 100:
        bpm_norm = max(0.0, min(100.0, (med_bpm - 85.0) * 1.15))
        adr_score = 0.55 * adr_base + 0.30 * bpm_norm + 0.15 * min(100.0, short_pct * 1.4)
    elif short_pct > 0:
        adr_score = 0.80 * adr_base + 0.20 * min(100.0, short_pct * 1.4)

    # Darkness blends genre darkness + explicitness + night share + dark lyrics
    dark_boost = min(20.0, exp_ratio * 15.0 + night_pct * 0.22 + themes.get("dark_industrial_intensity", 0) * 2.5)
    dark_score = 0.80 * dark_base + dark_boost

    # Theatricality blends symphonic/OST families + epic track lengths + battle/epic lyrics
    theat_boost = min(22.0, epic_pct * 0.35 + themes.get("epic_battle_fantasy", 0) * 3.0)
    theat_score = 0.78 * theat_base + theat_boost

    # Underground blends inverse popularity + niche genres
    if isinstance(mainstream_idx, (int, float)):
        und_score = 0.65 * (100.0 - float(mainstream_idx)) + 0.35 * und_base
    else:
        und_score = und_base

    # Eclecticism: Shannon entropy over macro families + exploration_index + session family transitions
    if macro_families and len(macro_families) > 1:
        probs = [max(0.001, float(f["share_pct"]) / 100.0) for f in macro_families if float(f.get("share_pct") or 0) > 0]
        if len(probs) > 1:
            fam_ent = -sum(p * math.log(p) for p in probs) / math.log(len(probs))
            ecl_base = fam_ent * 100.0
        else:
            ecl_base = 30.0
    else:
        ecl_base = 35.0
    trans_bonus = min(15.0, len(session_flow.get("family_transitions") or []) * 2.0)
    ecl_score = 0.60 * ecl_base + (0.40 * (float(exp_idx) * 100.0) if exp_idx is not None else 0.25 * ecl_base) + trans_bonus

    def clamp(val: float) -> int:
        return int(round(max(5.0, min(98.0, val))))

    return {
        "aggression_heaviness": {
            "label": "Impact & lourdeur",
            "score": clamp(agg_base),
            "drivers": [f["family"] for f in macro_families if _FAMILY_SONIC_WEIGHTS.get(f["family"], (0,))[0] >= 0.65][:3],
        },
        "adrenaline_velocity": {
            "label": "Vélocité & adrénaline",
            "score": clamp(adr_score),
            "drivers": ([f"BPM médian {int(med_bpm)}"] if med_bpm else []) + ([f"{round(short_pct)}% formats courts <150s"] if short_pct >= 15 else []),
        },
        "darkness_edge": {
            "label": "Noirceur & tension",
            "score": clamp(dark_score),
            "drivers": ([f"{round(night_pct)}% écoutes nocturnes"] if night_pct >= 15 else []) + ([f"explicit {round(exp_ratio * 100)}%"] if exp_ratio >= 0.25 else []),
        },
        "theatricality_epic": {
            "label": "Théâtralité & souffle épique",
            "score": clamp(theat_score),
            "drivers": ([f"{round(epic_pct)}% fresques >270s"] if epic_pct >= 15 else []) + (["thèmes épiques"] if themes.get("epic_battle_fantasy") else []),
        },
        "underground_niche": {
            "label": "Niche & underground",
            "score": clamp(und_score),
            "drivers": ([f"popularité moy. {mainstream_idx}/100"] if mainstream_idx is not None else ["biais niches spécialisées"]),
        },
        "eclecticism_volatility": {
            "label": "Éclectisme & grand écart",
            "score": clamp(ecl_score),
            "drivers": ([f"{len(macro_families)} familles actives"] if macro_families else []) + ([f"entropie {exp_idx}"] if exp_idx is not None else []),
        },
    }


def _detect_taste_paradoxes(
    macro_families: list[dict[str, Any]],
    dur_profile: dict[str, Any],
    circadian_profile: dict[str, Any],
    acoustic_fingerprint: dict[str, Any],
    session_flow: dict[str, Any],
) -> list[dict[str, str]]:
    """Identify sharp empirically observed dualities in Master's taste architecture."""
    paradoxes: list[dict[str, str]] = []
    short_p = float(dur_profile.get("short_under_150s_pct") or 0.0)
    epic_p = float(dur_profile.get("epic_over_270s_pct") or 0.0)
    if short_p >= 15 and epic_p >= 15:
        paradoxes.append({
            "title": "Bimodalité sprint / fresque",
            "detail": f"{short_p}% de décharges ultra-courtes (<150s) cohabitent avec {epic_p}% de pièces épiques (>270s).",
        })

    fam_names = [f["family"] for f in macro_families[:4]]
    if "Metal & Heavy" in fam_names and "Phonk & Drift" in fam_names:
        paradoxes.append({
            "title": "Axe acier-basse (Metal × Phonk)",
            "detail": "Le pont se fait sur la saturation rythmique et l'adrénaline frontale plutôt que sur l'instrumentation.",
        })

    dp = circadian_profile.get("dayparts") or {}
    day_arts = set((dp.get("matin") or {}).get("top_artists") or []) | set((dp.get("apres-midi") or {}).get("top_artists") or [])
    night_arts = set((dp.get("nuit") or {}).get("top_artists") or [])
    if day_arts and night_arts and len(day_arts & night_arts) == 0:
        paradoxes.append({
            "title": "Schisme diurne / nocturne",
            "detail": f"Rotation diurne ({', '.join(sorted(day_arts)[:2])}) totalement distincte des écoutes de nuit ({', '.join(sorted(night_arts)[:2])}).",
        })

    conc = acoustic_fingerprint.get("artist_concentration_top5_pct")
    exp_idx = acoustic_fingerprint.get("exploration_index")
    if conc is not None and exp_idx is not None and conc >= 35 and exp_idx >= 0.72:
        paradoxes.append({
            "title": "Fidélité de noyau + papillonnage périphérique",
            "detail": f"Le Top 5 capte {conc}% du volume tout en gardant un indice d'exploration élevé ({exp_idx}).",
        })

    if (session_flow.get("family_transitions") or []):
        ft = session_flow["family_transitions"][0]
        paradoxes.append({
            "title": "Passerelle de session dominante",
            "detail": f"Transition fréquente {ft['from']} → {ft['to']} ({ft['count']}×).",
        })

    return paradoxes[:6]


def _build_actionable_recipes(
    dossier: dict[str, Any],
    overrides: dict[str, Any],
) -> dict[str, Any]:
    """Generate immediately usable recipes for Musica, DJ Musica, Mixer, and Radar."""
    dp = (dossier.get("circadian_profile") or {}).get("dayparts") or {}
    mood_ov = overrides.get("mood_rules_override") or {}
    soundtracks: dict[str, Any] = {}
    for slot in ("matin", "apres-midi", "soiree", "nuit"):
        if mood_ov.get(slot):
            soundtracks[slot] = {"directive": mood_ov[slot], "source": "manual_override"}
        elif (dp.get(slot) or {}).get("top_artists"):
            soundtracks[slot] = {
                "artists": (dp[slot].get("top_artists") or [])[:4],
                "share_pct": dp[slot].get("share_pct"),
                "source": "circadian_empirical",
            }
    for ctx_slot in ("sport", "focus"):
        if mood_ov.get(ctx_slot):
            soundtracks[ctx_slot] = {"directive": mood_ov[ctx_slot], "source": "manual_override"}

    cal = (dossier.get("calendar_correlation") or {}).get("activities") or {}
    if "sport" in cal and "sport" not in soundtracks:
        soundtracks["sport"] = {"artists": cal["sport"].get("top_artists", [])[:4], "source": "calendar_empirical"}
    if "work_coding" in cal and "focus" not in soundtracks:
        soundtracks["focus"] = {"artists": cal["work_coding"].get("top_artists", [])[:4], "source": "calendar_empirical"}

    constellations = dossier.get("sonic_constellations") or []
    mixer_blend = [
        {"name": c["label"], "weight_pct": c["weight_pct"], "playlists": c.get("playlists") or [], "anchors": (c.get("artists") or [])[:3]}
        for c in constellations[:4]
    ]

    cooldown_14d = [x["name"] for x in ((dossier.get("fatigue_profile") or {}).get("overplay_fatigue") or [])[:6]]
    surging = (dossier.get("genre_profile") or {}).get("surging_genres") or []
    pillars = [a["name"] for a in (dossier.get("artist_affinities") or [])[:6]]
    discovery_seeds = {
        "artists": pillars[:4],
        "genres": (overrides.get("boosted_genres") or []) + surging[:4],
        "target_familiarity": (dossier.get("novelty_profile") or {}).get("manual_target_familiarity")
        or (dossier.get("novelty_profile") or {}).get("optimal_familiarity"),
        "target_bpm_range": overrides.get("target_bpm_range"),
    }

    return {
        "daypart_soundtracks": soundtracks,
        "mixer_blend": mixer_blend,
        "cooldown_rest_14d": cooldown_14d,
        "discovery_seeds": discovery_seeds,
    }


def _cluster_constellations(
    nodes: list[str],
    edges: dict[tuple[str, str], float],
) -> dict[str, int]:
    """Weighted deterministic label propagation for sonic constellations."""
    neighbours: dict[str, dict[str, float]] = defaultdict(dict)
    for (a, b), w in edges.items():
        if a in nodes and b in nodes and w > 0:
            neighbours[a][b] = w
            neighbours[b][a] = w
    labels = {n: i for i, n in enumerate(nodes)}
    for _ in range(12):
        changed = False
        for node in nodes:
            votes: dict[int, float] = defaultdict(float)
            for other, w in neighbours[node].items():
                votes[labels[other]] += w
            if votes:
                best = max(votes.items(), key=lambda kv: (kv[1], -kv[0]))[0]
                if best != labels[node]:
                    labels[node] = best
                    changed = True
        if not changed:
            break
    remap = {old: idx for idx, old in enumerate(sorted(set(labels.values())))}
    return {n: remap[labels[n]] for n in nodes}


# ---------------------------------------------------------------------------
# 4. Main Exhaustive Taste Analyzer
# ---------------------------------------------------------------------------

def analyze_profile(
    *,
    raw: dict[str, Any] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Fuse all Spotify + local HQ + override signals into a 14-layer taste dossier."""
    now = now or datetime.now(timezone.utc)
    taste = music.get_taste()
    if not taste.get("history_sharing", True):
        return {
            "version": 2,
            "analyzed_utc": _utcnow(),
            "history_sharing": False,
            "source_coverage": {},
            "artist_affinities": [],
            "cooling_and_rejected": [],
            "genre_profile": {"top_genres": [], "macro_families": [], "surging_genres": []},
            "sonic_axes": {},
            "sonic_constellations": [],
            "bridge_hubs": [],
            "track_signatures": {"top_tracks": [], "hidden_gems": [], "pinned_tracks": []},
            "album_architecture": {"listening_style": "unknown", "top_albums": []},
            "collaboration_network": {"top_collaborations": [], "hub_artists": []},
            "circadian_profile": {"dayparts": {}, "hourly_curve": [], "weekday_curve": [], "weekday_vs_weekend": {}, "binge_profile": {}},
            "acoustic_fingerprint": {},
            "playlist_archetypes": [],
            "behavioral_signals": {},
            "session_flow": {},
            "lyrical_profile": {},
            "fatigue_profile": {},
            "calendar_correlation": {},
            "novelty_profile": {},
            "tournament_intelligence": {},
            "drift_profile": {},
            "taste_paradoxes": [],
            "actionable_recipes": {},
            "taste_summary_text": "Partage d'historique désactivé.",
            "ai_synthesis": None,
        }

    raw = raw if isinstance(raw, dict) else _load_raw()
    sp = raw.get("spotify") if isinstance(raw.get("spotify"), dict) else {}
    artist_cache: dict[str, Any] = sp.get("artist_cache") if isinstance(sp.get("artist_cache"), dict) else {}
    overrides = get_overrides()
    profile_doc = music.get_profile()

    # Index artist metadata by casefolded name
    meta_by_name: dict[str, dict[str, Any]] = {}
    for entry in artist_cache.values():
        if isinstance(entry, dict) and entry.get("name"):
            k = entry["name"].strip().casefold()
            prev = meta_by_name.get(k) or {}
            genres = entry.get("genres") or prev.get("genres") or []
            meta_by_name[k] = {
                "id": entry.get("id") or prev.get("id"),
                "name": entry["name"],
                "genres": genres,
                "popularity": entry.get("popularity") if isinstance(entry.get("popularity"), int) else prev.get("popularity"),
                "followers": entry.get("followers") if isinstance(entry.get("followers"), int) else prev.get("followers"),
                "country": entry.get("country") or prev.get("country"),
                "artist_type": entry.get("artist_type") or prev.get("artist_type"),
            }

    artists: dict[str, dict[str, Any]] = {}
    track_ledger: dict[str, dict[str, Any]] = {}
    album_ledger: dict[str, dict[str, Any]] = {}
    collab_pairs: Counter[tuple[str, str]] = Counter()
    collab_names: dict[str, str] = {}
    artist_sample_tracks: dict[str, list[dict[str, Any]]] = defaultdict(list)

    def ensure_artist(name: str) -> dict[str, Any] | None:
        clean = " ".join(str(name or "").split()).strip()
        if not clean:
            return None
        key = clean.casefold()
        if key not in artists:
            meta = meta_by_name.get(key) or {}
            artists[key] = {
                "key": key,
                "name": meta.get("name") or clean,
                "genres": list(meta.get("genres") or []),
                "genres_inferred": False,
                "popularity": meta.get("popularity"),
                "country": meta.get("country"),
                "sp_score": 0.0,
                "sp_short_score": 0.0,
                "sp_long_score": 0.0,
                "sp_ranks": {},
                "journal_plays": 0,
                "journal_recent_14d": 0,
                "journal_score": 0.0,
                "saved_tracks": 0,
                "saved_albums": 0,
                "playlists": set(),
                "smtc_plays": 0,
                "dj_done": 0,
                "dj_skipped": 0,
                "explicit_love": 0,
                "explicit_reject": 0,
                "manual_boost": 0.0,
                "tournament_wins": 0,
                "tournament_losses": 0,
                "tournament_titles": 0,
                "radar_releases": 0,
                "sources": set(),
            }
        return artists[key]

    def record_track_signal(
        *,
        name: Any,
        track_artists: list[Any],
        score_delta: float = 0.0,
        source: str | None = None,
        uri: Any = None,
        album: Any = None,
        duration_ms: Any = None,
        year: Any = None,
        popularity: Any = None,
        journal_inc: int = 0,
        recent14_inc: int = 0,
        saved: bool = False,
        playlist_name: str | None = None,
        pool: str | None = None,
    ) -> None:
        tname = " ".join(str(name or "").split()).strip()
        clean_arts = [" ".join(str(a or "").split()).strip() for a in (track_artists or []) if str(a or "").strip()]
        if not tname or not clean_arts:
            return
        tkey = f"{clean_arts[0].casefold()}||{tname.casefold()}"
        rec = track_ledger.get(tkey)
        if rec is None:
            rec = {
                "name": tname,
                "artists": clean_arts,
                "uri": uri,
                "album": str(album or "").strip() or None,
                "duration_ms": int(duration_ms) if isinstance(duration_ms, (int, float)) and duration_ms > 0 else None,
                "year": str(year)[:4] if year else None,
                "popularity": popularity if isinstance(popularity, int) else None,
                "score": 0.0,
                "journal_plays": 0,
                "recent_14d": 0,
                "saved": False,
                "playlists": set(),
                "pools": set(),
                "sources": set(),
                "tournament_wins": 0,
                "tournament_titles": 0,
                "deep_cut": pool == "deep_cuts",
            }
            track_ledger[tkey] = rec
        rec["score"] += score_delta
        rec["journal_plays"] += journal_inc
        rec["recent_14d"] += recent14_inc
        if saved:
            rec["saved"] = True
        if uri and not rec["uri"]:
            rec["uri"] = uri
        if album and not rec["album"]:
            rec["album"] = str(album).strip()
        if isinstance(duration_ms, (int, float)) and duration_ms > 0 and not rec["duration_ms"]:
            rec["duration_ms"] = int(duration_ms)
        if year and not rec["year"]:
            rec["year"] = str(year)[:4]
        if isinstance(popularity, int) and rec["popularity"] is None:
            rec["popularity"] = popularity
        if source:
            rec["sources"].add(source)
        if playlist_name:
            rec["playlists"].add(playlist_name)
        if pool:
            rec["pools"].add(pool)
            if pool == "deep_cuts":
                rec["deep_cut"] = True

        # Album aggregation
        if rec["album"]:
            akey = f"{clean_arts[0].casefold()}||{rec['album'].casefold()}"
            al = album_ledger.setdefault(akey, {
                "album": rec["album"],
                "artist": clean_arts[0],
                "year": rec["year"],
                "saved": False,
                "tracks": set(),
                "plays": 0,
                "score": 0.0,
            })
            al["tracks"].add(tname.casefold())
            al["plays"] += journal_inc
            al["score"] += score_delta + (0.6 if saved else 0.0)
            if year and not al["year"]:
                al["year"] = str(year)[:4]

        # Track references per lead artist (for contextual genre inference)
        lead_cf = clean_arts[0].casefold()
        if len(artist_sample_tracks[lead_cf]) < 15:
            artist_sample_tracks[lead_cf].append({"name": tname, "album": rec["album"]})

        # Multi-artist collaboration edges
        if len(clean_arts) >= 2:
            for ca in clean_arts:
                collab_names.setdefault(ca.casefold(), ca)
            for i in range(len(clean_arts)):
                for j in range(i + 1, len(clean_arts)):
                    a1, a2 = clean_arts[i].casefold(), clean_arts[j].casefold()
                    if a1 != a2:
                        collab_pairs[tuple(sorted((a1, a2)))] += 1

    # --- A. Spotify Top Artists ---
    period_weights = {"short": 1.0, "medium": 0.75, "long": 0.55}
    top_artists_map = sp.get("top_artists") if isinstance(sp.get("top_artists"), dict) else {}
    for period, w in period_weights.items():
        for idx, item in enumerate(top_artists_map.get(period) or []):
            if not isinstance(item, dict) or not item.get("name"):
                continue
            a = ensure_artist(item["name"])
            if not a:
                continue
            if item.get("genres") and not a["genres"]:
                a["genres"] = list(item["genres"])
            if isinstance(item.get("popularity"), int) and a["popularity"] is None:
                a["popularity"] = item["popularity"]
            rank_score = w * (5.0 * math.exp(-idx / 14.0))
            a["sp_score"] += rank_score
            if period == "short":
                a["sp_short_score"] += rank_score
            elif period == "long":
                a["sp_long_score"] += rank_score
            a["sp_ranks"][period] = idx + 1
            a["sources"].add(f"spotify_top_{period}")

    # --- B. Spotify Top Tracks ---
    track_pool_for_stats: list[dict[str, Any]] = []
    seen_stat_uris: set[str] = set()

    def add_stat_track(t: dict[str, Any]) -> None:
        if not isinstance(t, dict):
            return
        uid = str(t.get("uri") or t.get("id") or f"{t.get('name')}|{'/'.join(t.get('artists') or [])}")
        if uid not in seen_stat_uris:
            seen_stat_uris.add(uid)
            track_pool_for_stats.append(t)

    top_tracks_map = sp.get("top_tracks") if isinstance(sp.get("top_tracks"), dict) else {}
    for period, w in period_weights.items():
        for idx, t in enumerate(top_tracks_map.get(period) or []):
            if not isinstance(t, dict):
                continue
            add_stat_track(t)
            pts = w * (1.2 * math.exp(-idx / 18.0))
            record_track_signal(
                name=t.get("name"), track_artists=t.get("artists") or [],
                score_delta=pts * 1.5, source=f"spotify_top_{period}",
                uri=t.get("uri"), album=t.get("album"),
                duration_ms=t.get("duration_ms"), year=t.get("year"), popularity=t.get("popularity"),
            )
            for aname in t.get("artists") or []:
                a = ensure_artist(aname)
                if a:
                    a["sp_score"] += pts
                    if period == "short":
                        a["sp_short_score"] += pts
                    elif period == "long":
                        a["sp_long_score"] += pts
                    a["sources"].add("spotify_top_tracks")

    # --- C. Spotify Recently Played ---
    for t in sp.get("recent") or []:
        if not isinstance(t, dict):
            continue
        add_stat_track(t)
        record_track_signal(
            name=t.get("name"), track_artists=t.get("artists") or [],
            score_delta=0.6, source="spotify_recent", uri=t.get("uri"),
            album=t.get("album"), duration_ms=t.get("duration_ms"),
            year=t.get("year"), popularity=t.get("popularity"),
        )
        for aname in t.get("artists") or []:
            a = ensure_artist(aname)
            if a:
                a["sp_score"] += 0.35
                a["sp_short_score"] += 0.35
                a["sources"].add("spotify_recent")

    # --- D. Saved Tracks, Albums & Followed ---
    cutoff_30d = now - timedelta(days=30)
    cutoff_90d = now - timedelta(days=90)
    recent_likes_30d = 0
    recent_likes_90d = 0
    for t in sp.get("saved_tracks") or []:
        if not isinstance(t, dict):
            continue
        add_stat_track(t)
        added_dt = _parse_dt(t.get("added_at"))
        is_recent_like = bool(added_dt and added_dt >= cutoff_30d)
        if is_recent_like:
            recent_likes_30d += 1
        if added_dt and added_dt >= cutoff_90d:
            recent_likes_90d += 1
        record_track_signal(
            name=t.get("name"), track_artists=t.get("artists") or [],
            score_delta=1.0 if is_recent_like else 0.75, source="saved_tracks",
            uri=t.get("uri"), album=t.get("album"),
            duration_ms=t.get("duration_ms"), year=t.get("year"),
            popularity=t.get("popularity"), saved=True,
        )
        for aname in t.get("artists") or []:
            a = ensure_artist(aname)
            if a:
                a["saved_tracks"] += 1
                a["sp_score"] += 0.65 if is_recent_like else 0.45
                if is_recent_like:
                    a["sp_short_score"] += 0.6
                a["sources"].add("saved_tracks")

    for alb in sp.get("saved_albums") or []:
        if not isinstance(alb, dict):
            continue
        alb_name = str(alb.get("name") or "").strip()
        alb_arts = alb.get("artists") or []
        if alb_name and alb_arts:
            akey = f"{str(alb_arts[0]).strip().casefold()}||{alb_name.casefold()}"
            al = album_ledger.setdefault(akey, {
                "album": alb_name, "artist": str(alb_arts[0]).strip(),
                "year": str(alb.get("year") or "")[:4] or None,
                "saved": True, "tracks": set(), "plays": 0, "score": 0.0,
            })
            al["saved"] = True
            al["score"] += 2.5
        for aname in alb_arts:
            a = ensure_artist(aname)
            if a:
                a["saved_albums"] += 1
                a["sp_score"] += 1.25
                a["sources"].add("saved_albums")

    for fa in sp.get("followed_artists") or []:
        if isinstance(fa, dict) and fa.get("name"):
            a = ensure_artist(fa["name"])
            if a:
                if fa.get("genres") and not a["genres"]:
                    a["genres"] = list(fa["genres"])
                a["sp_score"] += 1.5
                a["sources"].add("followed")

    # --- E. Playlists & Archetypes ---
    playlist_archetypes: list[dict[str, Any]] = []
    co_edges: dict[tuple[str, str], float] = defaultdict(float)

    for pl in sp.get("playlists") or []:
        if not isinstance(pl, dict):
            continue
        pl_name = str(pl.get("name") or "Playlist")
        pl_tracks = pl.get("tracks") or []
        pl_artist_counts: Counter[str] = Counter()
        pl_genre_counts: Counter[str] = Counter()
        pl_durs: list[float] = []
        pl_artists_set: set[str] = set()

        for t in pl_tracks:
            if not isinstance(t, dict):
                continue
            add_stat_track(t)
            if isinstance(t.get("duration_ms"), int) and t["duration_ms"] > 0:
                pl_durs.append(t["duration_ms"] / 1000.0)
            record_track_signal(
                name=t.get("name"), track_artists=t.get("artists") or [],
                score_delta=0.45, source="playlists", uri=t.get("uri"),
                album=t.get("album"), duration_ms=t.get("duration_ms"),
                year=t.get("year"), popularity=t.get("popularity"), playlist_name=pl_name,
            )
            for aname in t.get("artists") or []:
                a = ensure_artist(aname)
                if a:
                    a["playlists"].add(pl_name)
                    a["sp_score"] += 0.25
                    a["sources"].add("playlists")
                    pl_artist_counts[a["name"]] += 1
                    pl_artists_set.add(a["key"])
                    for g in a["genres"]:
                        pl_genre_counts[g] += 1

        top_pl_keys = [k for k in pl_artists_set][:25]
        for i in range(len(top_pl_keys)):
            for j in range(i + 1, len(top_pl_keys)):
                pair = tuple(sorted((top_pl_keys[i], top_pl_keys[j])))
                co_edges[pair] += 0.6

        avg_dur = round(sum(pl_durs) / len(pl_durs), 1) if pl_durs else 0.0
        top_pl_genres = [g for g, _c in pl_genre_counts.most_common(4)]
        playlist_archetypes.append({
            "name": pl_name,
            "tracks_total": int(pl.get("tracks_total") or len(pl_tracks)),
            "tracks_scanned": len(pl_tracks),
            "top_artists": [n for n, _c in pl_artist_counts.most_common(5)],
            "top_genres": top_pl_genres,
            "avg_duration_sec": avg_dur,
            "archetype": _playlist_archetype(pl_name, top_pl_genres, avg_dur),
        })

    # --- F. Local DJ Dig Cache (pools, playlist hints, deep cuts, albums) ---
    dig_pools = _collect_dig_cache()
    dig_tracks_count = 0
    seen_dig_pl: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for pool_name, rows in dig_pools.items():
        dig_tracks_count += len(rows)
        pool_pts = {"liked": 0.45, "classics": 0.65, "playlists": 0.40, "followed": 0.50, "deep_cuts": 0.35}.get(pool_name, 0.25)
        for t in rows:
            add_stat_track(t)
            why_txt = str(t.get("why") or "")
            pl_match = re.search(r"playlist\s+[«\"]([^»\"]+)[»\"]", why_txt)
            pl_hint = pl_match.group(1).strip() if pl_match else None
            if pl_hint:
                seen_dig_pl[pl_hint].append(t)
            record_track_signal(
                name=t.get("name"), track_artists=t.get("artists") or [],
                score_delta=pool_pts, source="dj_dig_cache", uri=t.get("uri"),
                album=t.get("album"), duration_ms=t.get("duration_ms"),
                playlist_name=pl_hint, pool=pool_name, saved=(pool_name == "liked"),
            )
            for aname in t.get("artists") or []:
                a = ensure_artist(aname)
                if a:
                    a["sp_score"] += pool_pts * 0.6
                    if pl_hint:
                        a["playlists"].add(pl_hint)
                    if pool_name == "liked":
                        a["saved_tracks"] = max(a["saved_tracks"], 1)
                    a["sources"].add("dj_dig_cache")

    # Add synthetic playlist archetypes discovered via dj-dig-cache if Spotify raw playlists weren't scanned
    existing_pl_names = {p["name"].casefold() for p in playlist_archetypes}
    for pl_name, pl_rows in seen_dig_pl.items():
        if pl_name.casefold() in existing_pl_names:
            continue
        pl_durs = [r["duration_ms"] / 1000.0 for r in pl_rows if isinstance(r.get("duration_ms"), (int, float)) and r["duration_ms"] > 0]
        avg_d = round(sum(pl_durs) / len(pl_durs), 1) if pl_durs else 0.0
        pl_arts = Counter(str(an) for r in pl_rows for an in (r.get("artists") or []) if an)
        playlist_archetypes.append({
            "name": pl_name,
            "tracks_total": len(pl_rows),
            "tracks_scanned": len(pl_rows),
            "top_artists": [n for n, _c in pl_arts.most_common(5)],
            "top_genres": [],
            "avg_duration_sec": avg_d,
            "archetype": _playlist_archetype(pl_name, [], avg_d),
        })

    # --- G. Local Listening Journal (Plays, Recency Decay, 24h Curve, Sessions) ---
    j_index, j_plays = _collect_journal_plays(now)
    j_artists_idx = j_index.get("artists") if isinstance(j_index.get("artists"), dict) else {}
    for entry in j_artists_idx.values():
        if not isinstance(entry, dict) or not entry.get("name"):
            continue
        a = ensure_artist(entry["name"])
        if not a:
            continue
        cnt = int(entry.get("count") or 0)
        a["journal_plays"] = max(a["journal_plays"], cnt)
        last_dt = _parse_dt(entry.get("last"))
        age_days = max(0.0, (now - last_dt).total_seconds() / 86400.0) if last_dt else 60.0
        recency = math.exp(-age_days / 45.0)
        a["journal_score"] += math.log1p(cnt) * (0.65 + 0.85 * recency)
        a["sources"].add("journal")

    daypart_stats: dict[str, dict[str, Any]] = {
        dp: {"plays": 0, "artists": Counter(), "durations": []}
        for dp in ("matin", "apres-midi", "soiree", "nuit")
    }
    hourly_stats: dict[int, dict[str, Any]] = {
        h: {"plays": 0, "artists": Counter()} for h in range(24)
    }
    weekday_stats: dict[int, dict[str, Any]] = {
        wd: {"plays": 0, "artists": Counter()} for wd in range(7)
    }
    weekday_plays = 0
    weekend_plays = 0
    weekday_artists: Counter[str] = Counter()
    weekend_artists: Counter[str] = Counter()
    hour_hist: Counter[int] = Counter()
    weekday_hist: Counter[int] = Counter()
    active_days: set[date] = set()
    play_artist_counter: Counter[str] = Counter()

    prev_lead: tuple[str, datetime] | None = None
    cutoff_14d = now - timedelta(days=14)
    night_owl_plays = 0
    session_lengths_calc: list[int] = []
    cur_sess_len = 0
    last_sess_dt: datetime | None = None

    for day, local_dt, row in j_plays:
        active_days.add(day)
        hr = local_dt.hour
        wd = day.weekday()
        hour_hist[hr] += 1
        weekday_hist[wd] += 1
        hourly_stats[hr]["plays"] += 1
        weekday_stats[wd]["plays"] += 1
        if hr >= 23 or hr < 5:
            night_owl_plays += 1
        dp = _daypart(local_dt)
        daypart_stats[dp]["plays"] += 1
        dur_ms = row.get("d")
        if isinstance(dur_ms, (int, float)) and dur_ms > 0:
            daypart_stats[dp]["durations"].append(float(dur_ms) / 1000.0)

        if last_sess_dt is not None and (local_dt - last_sess_dt).total_seconds() > LINK_GAP_SEC:
            if cur_sess_len:
                session_lengths_calc.append(cur_sess_len)
            cur_sess_len = 0
        cur_sess_len += 1
        last_sess_dt = local_dt

        is_weekend = wd >= 5
        if is_weekend:
            weekend_plays += 1
        else:
            weekday_plays += 1

        row_artists = [str(x).strip() for x in (row.get("a") or []) if isinstance(x, str) and x.strip()]
        is_recent_14 = local_dt.astimezone(timezone.utc) >= cutoff_14d
        record_track_signal(
            name=row.get("n"), track_artists=row_artists,
            score_delta=0.95 if is_recent_14 else 0.65,
            source="journal", uri=row.get("u"), duration_ms=dur_ms,
            journal_inc=1, recent14_inc=(1 if is_recent_14 else 0),
        )
        for aname in row_artists:
            a = ensure_artist(aname)
            if a:
                if is_recent_14:
                    a["journal_recent_14d"] += 1
                daypart_stats[dp]["artists"][a["name"]] += 1
                hourly_stats[hr]["artists"][a["key"]] += 1
                weekday_stats[wd]["artists"][a["name"]] += 1
                play_artist_counter[a["key"]] += 1
                if is_weekend:
                    weekend_artists[a["name"]] += 1
                else:
                    weekday_artists[a["name"]] += 1

        if row_artists:
            lead_key = row_artists[0].casefold()
            if prev_lead and prev_lead[0] != lead_key and (local_dt - prev_lead[1]).total_seconds() <= LINK_GAP_SEC:
                pair = tuple(sorted((prev_lead[0], lead_key)))
                co_edges[pair] += 1.0
            prev_lead = (lead_key, local_dt)

    if cur_sess_len:
        session_lengths_calc.append(cur_sess_len)

    # --- H. SMTC / HQ Play Memory (preserve both artist & track!) ---
    smtc_doc = music._load("musica_play_history.json", {"items": []})
    for item in smtc_doc.get("items") or []:
        if isinstance(item, dict) and item.get("artist"):
            cnt = int(item.get("play_count") or 1)
            a = ensure_artist(item["artist"])
            if a:
                a["smtc_plays"] += cnt
                a["journal_score"] += 0.4 * math.log1p(cnt)
                a["sources"].add("hq_play_memory")
            if item.get("title") or item.get("name"):
                record_track_signal(
                    name=item.get("title") or item.get("name"),
                    track_artists=[item["artist"]],
                    score_delta=0.5 * math.log1p(cnt),
                    source="hq_play_memory",
                    album=item.get("album"),
                )

    # --- I. Radar & Feedback History ---
    radar_items = _collect_radar()
    for rit in radar_items:
        for an in rit.get("artists") or []:
            a = ensure_artist(an)
            if a:
                a["radar_releases"] += 1
                a["sources"].add("release_radar")

    feedback_rejects: list[dict[str, Any]] = []
    for fb in (profile_doc.get("feedback_history") or []):
        if not isinstance(fb, dict):
            continue
        an = str(fb.get("artist") or "").strip()
        ti = str(fb.get("title") or "").strip()
        liked = fb.get("liked")
        if an:
            a = ensure_artist(an)
            if a:
                if liked is True:
                    a["explicit_love"] += 1
                    a["sources"].add("feedback_like")
                elif liked is False:
                    a["explicit_reject"] += 1
                    a["sources"].add("feedback_dismiss")
        if liked is False and (an or ti):
            feedback_rejects.append({"artist": an, "title": ti, "action": fb.get("action") or "dismiss", "at": fb.get("at_utc")})
        elif liked is True and ti and an:
            record_track_signal(name=ti, track_artists=[an], score_delta=2.0, source="feedback_like", uri=fb.get("uri"))

    # --- J. Tournament Hall Revealed Preference ---
    tournaments = _collect_tournaments()
    for ak, ta in (tournaments.get("artists") or {}).items():
        a = ensure_artist(ta["name"])
        if a:
            a["tournament_wins"] += int(ta.get("wins") or 0)
            a["tournament_losses"] += int(ta.get("losses") or 0)
            a["tournament_titles"] += int(ta.get("titles") or 0)
            a["sources"].add("tournaments")
    for s in (tournaments.get("songs") or {}).values():
        tkey = f"{str(s.get('artist') or '').casefold()}||{str(s.get('name') or '').casefold()}"
        if tkey in track_ledger:
            track_ledger[tkey]["tournament_wins"] += s["wins"]
            track_ledger[tkey]["tournament_titles"] += s["titles"]
            track_ledger[tkey]["score"] += s["wins"] * 1.1 + s["titles"] * 2.5
            track_ledger[tkey]["sources"].add("tournaments")
        elif s.get("wins") or s.get("titles"):
            record_track_signal(
                name=s["name"], track_artists=[s["artist"]] if s.get("artist") else [],
                score_delta=s["wins"] * 1.1 + s["titles"] * 2.5,
                source="tournaments", uri=s.get("uri"),
            )

    # --- K. DJ Musica Behavioral Signals ---
    dj_state = music._load("dj_state.json", {})
    for name, sig in (dj_state.get("artist_signal") or {}).items():
        if not isinstance(sig, dict):
            continue
        a = ensure_artist(sig.get("name") or name)
        if a:
            a["dj_done"] += int(sig.get("done") or 0)
            a["dj_skipped"] += int(sig.get("skipped") or 0)
            a["sources"].add("dj_signal")

    # --- L. Explicit Taste Ledger & Manual Overrides / Anchors ---
    for row in taste.get("loved") or []:
        if isinstance(row, dict) and row.get("artist"):
            a = ensure_artist(row["artist"])
            if a:
                a["explicit_love"] += 1
                a["sources"].add("explicit_love")
    for row in taste.get("rejected") or []:
        if isinstance(row, dict) and row.get("artist"):
            a = ensure_artist(row["artist"])
            if a:
                a["explicit_reject"] += 1
                a["sources"].add("explicit_reject")

    boosted_artist_keys = {x.strip().casefold() for x in (overrides.get("boosted_artists") or []) if x.strip()}
    favorite_artist_keys = {x.strip().casefold() for x in (overrides.get("favorite_artists") or []) if x.strip()}
    for fname in overrides.get("favorite_artists") or []:
        a = ensure_artist(fname)
        if a:
            a["manual_boost"] += 4.2
            a["sources"].add("manual_favorite")
    for bname in overrides.get("boosted_artists") or []:
        a = ensure_artist(bname)
        if a:
            a["manual_boost"] += 6.5
            a["sources"].add("manual_boost")

    banned_keys: set[str] = set()
    for bname in (taste.get("banned_artists") or []) + (taste.get("auto_excluded") or []):
        if isinstance(bname, str) and bname.strip():
            banned_keys.add(bname.strip().casefold())
            ensure_artist(bname)

    # Contextual genre inference ONLY for artists that still have zero Spotify/MusicBrainz/iTunes genres
    for key, a in artists.items():
        if not a["genres"] and key not in banned_keys:
            inferred = _infer_context_genres(key, artist_sample_tracks.get(key, []), a["playlists"])
            if inferred:
                a["genres"] = inferred
                a["genres_inferred"] = True

    # --- Compute Composite Artist Affinity Scores, Tiers, Trajectories ---
    scored_artists: list[dict[str, Any]] = []
    cooling_artists: list[dict[str, Any]] = []

    for key, a in artists.items():
        done = a["dj_done"]
        skipped = a["dj_skipped"]
        total_dj = done + skipped
        completion_rate = round((done + 1) / (total_dj + 2), 3)
        dj_mod = 0.7 * done - 1.35 * skipped
        explicit_mod = 3.0 * a["explicit_love"] - 3.2 * a["explicit_reject"]
        tourn_mod = 0.85 * a["tournament_wins"] + 2.2 * a["tournament_titles"] - 0.35 * a["tournament_losses"]
        playlist_bonus = min(3.0, len(a["playlists"]) * 0.75)
        raw_score = a["sp_score"] + a["journal_score"] + playlist_bonus + dj_mod + explicit_mod + tourn_mod + a["manual_boost"]

        if key in banned_keys or raw_score < 0:
            cooling_artists.append({
                "name": a["name"],
                "score": round(raw_score, 2),
                "banned": key in banned_keys,
                "dj_done": done,
                "dj_skipped": skipped,
                "explicit_reject": a["explicit_reject"],
            })
            continue

        short_momentum = a["sp_short_score"] + a["journal_recent_14d"] * 0.6
        long_baseline = a["sp_long_score"] + max(0.0, a["journal_plays"] - a["journal_recent_14d"]) * 0.15
        if short_momentum > max(1.5, long_baseline * 1.45):
            trajectory = "surging"
        elif short_momentum > long_baseline * 1.05 and short_momentum > 0.8:
            trajectory = "climbing"
        elif long_baseline > 2.5 and short_momentum < long_baseline * 0.35:
            trajectory = "fading"
        else:
            trajectory = "stable"

        is_manual = key in boosted_artist_keys or key in favorite_artist_keys
        if (raw_score >= 9.0 and len(a["sources"]) >= 2) or (key in boosted_artist_keys and raw_score >= 6.0):
            tier = "core_pillar"
        elif trajectory == "surging" and raw_score >= 4.0:
            tier = "active_obsession"
        elif trajectory in {"surging", "climbing"}:
            tier = "rising"
        elif trajectory == "fading":
            tier = "nostalgic"
        else:
            tier = "steady"

        scored_artists.append({
            "key": key,
            "name": a["name"],
            "score": round(raw_score, 2),
            "tier": tier,
            "trajectory": trajectory,
            "genres": a["genres"],
            "genres_inferred": a["genres_inferred"],
            "country": a["country"],
            "popularity": a["popularity"],
            "journal_plays": a["journal_plays"],
            "recent_14d_plays": a["journal_recent_14d"],
            "spotify_ranks": a["sp_ranks"],
            "saved_tracks": a["saved_tracks"],
            "saved_albums": a["saved_albums"],
            "playlist_count": len(a["playlists"]),
            "playlists": sorted(a["playlists"])[:6],
            "dj_done": done,
            "dj_skipped": skipped,
            "tournament_wins": a["tournament_wins"],
            "tournament_titles": a["tournament_titles"],
            "completion_rate": completion_rate,
            "manual_pinned": is_manual,
            "sources": sorted(a["sources"]),
        })

    scored_artists.sort(key=lambda x: (-x["score"], x["name"]))
    cooling_artists.sort(key=lambda x: (x["score"], x["name"]))

    # --- Genre & Subgenre Taxonomy + Macro Families (incl. Manual Preferred/Boosted Genres) ---
    genre_scores: dict[str, float] = defaultdict(float)
    genre_short_scores: dict[str, float] = defaultdict(float)
    genre_long_scores: dict[str, float] = defaultdict(float)
    genre_artists: dict[str, list[str]] = defaultdict(list)
    manual_genre_keys: set[str] = set()

    for a in scored_artists:
        if not a["genres"]:
            continue
        src_a = artists[a["key"]]
        conf_mult = 0.55 if a["genres_inferred"] else 1.0
        for g in a["genres"]:
            gclean = str(g).strip().lower()
            if not gclean:
                continue
            specificity = 1.15 if " " in gclean else 0.85
            w = a["score"] * specificity * conf_mult / max(1.0, math.sqrt(len(a["genres"])))
            genre_scores[gclean] += w
            genre_short_scores[gclean] += (src_a["sp_short_score"] + src_a["journal_recent_14d"] * 0.5) * specificity * conf_mult
            genre_long_scores[gclean] += (src_a["sp_long_score"] + src_a["journal_plays"] * 0.12) * specificity * conf_mult
            if len(genre_artists[gclean]) < 5 and a["name"] not in genre_artists[gclean]:
                genre_artists[gclean].append(a["name"])

    for mg in overrides.get("preferred_genres") or []:
        gclean = mg.strip().lower()
        if gclean:
            manual_genre_keys.add(gclean)
            genre_scores[gclean] += 5.5
    for bg in overrides.get("boosted_genres") or []:
        gclean = bg.strip().lower()
        if gclean:
            manual_genre_keys.add(gclean)
            genre_scores[gclean] += 9.0

    total_g = sum(genre_scores.values()) or 1.0
    top_genres: list[dict[str, Any]] = []
    surging_genres: list[str] = []
    macro_scores: dict[str, float] = defaultdict(float)
    macro_subgenres: dict[str, list[str]] = defaultdict(list)
    macro_artists: dict[str, list[str]] = defaultdict(list)

    for g, sc in sorted(genre_scores.items(), key=lambda kv: -kv[1]):
        share = round((sc / total_g) * 100.0, 1)
        g_short = genre_short_scores[g]
        g_long = genre_long_scores[g]
        if g_short > max(1.0, g_long * 1.4):
            traj = "surging"
            if len(surging_genres) < 10:
                surging_genres.append(g)
        elif g_long > 2.0 and g_short < g_long * 0.35:
            traj = "fading"
        else:
            traj = "stable"

        if len(top_genres) < 35:
            top_genres.append({
                "genre": g,
                "score": round(sc, 2),
                "share_pct": share,
                "trajectory": traj,
                "manual": g in manual_genre_keys,
                "top_artists": genre_artists[g],
            })

        fam = _macro_family(g)
        macro_scores[fam] += sc
        if g not in macro_subgenres[fam] and len(macro_subgenres[fam]) < 5:
            macro_subgenres[fam].append(g)
        for aname in genre_artists[g]:
            if aname not in macro_artists[fam] and len(macro_artists[fam]) < 5:
                macro_artists[fam].append(aname)

    total_m = sum(macro_scores.values()) or 1.0
    macro_families = [
        {
            "family": fam,
            "score": round(sc, 2),
            "share_pct": round((sc / total_m) * 100.0, 1),
            "top_subgenres": macro_subgenres[fam],
            "top_artists": macro_artists[fam],
        }
        for fam, sc in sorted(macro_scores.items(), key=lambda kv: -kv[1])
    ]

    # --- Sonic Constellations & Bridge Hubs ---
    top_cluster_nodes = [a["key"] for a in scored_artists[:40]]
    for i in range(len(top_cluster_nodes)):
        k1 = top_cluster_nodes[i]
        g1 = set(artists[k1]["genres"])
        if not g1:
            continue
        for j in range(i + 1, len(top_cluster_nodes)):
            k2 = top_cluster_nodes[j]
            g2 = set(artists[k2]["genres"])
            overlap = len(g1 & g2)
            if overlap:
                pair = tuple(sorted((k1, k2)))
                co_edges[pair] += 0.85 * overlap

    cluster_map = _cluster_constellations(top_cluster_nodes, co_edges)
    cluster_groups: dict[int, list[dict[str, Any]]] = defaultdict(list)
    artist_by_key = {a["key"]: a for a in scored_artists}
    for key, cid in cluster_map.items():
        if key in artist_by_key:
            cluster_groups[cid].append(artist_by_key[key])

    sonic_constellations: list[dict[str, Any]] = []
    total_cluster_score = sum(a["score"] for a in scored_artists[:40]) or 1.0
    for cid, members in sorted(cluster_groups.items(), key=lambda kv: -sum(m["score"] for m in kv[1])):
        members.sort(key=lambda m: -m["score"])
        c_genres: Counter[str] = Counter()
        c_playlists: Counter[str] = Counter()
        for m in members:
            for g in m["genres"]:
                c_genres[g] += 1
            for pl in m["playlists"]:
                c_playlists[pl] += 1
        top_cg = [g for g, _c in c_genres.most_common(3)]
        top_cp = [p for p, _c in c_playlists.most_common(2)]
        label_parts = [g.title() for g in top_cg[:2]] or [m["name"] for m in members[:2]]
        label = " / ".join(label_parts)
        c_score = sum(m["score"] for m in members)
        sonic_constellations.append({
            "id": f"constellation_{cid}",
            "label": label,
            "weight_pct": round((c_score / total_cluster_score) * 100.0, 1),
            "artists": [m["name"] for m in members[:8]],
            "top_genres": top_cg,
            "playlists": top_cp,
        })

    # Bridge hubs: artists spanning >= 2 macro families OR connected across different clusters in co_edges
    bridge_hubs: list[dict[str, Any]] = []
    for a in scored_artists[:35]:
        fams = list(dict.fromkeys(_macro_family(g) for g in a["genres"]))
        linked_clusters = {
            cluster_map[other]
            for (n1, n2), w in co_edges.items()
            if w >= 1.0 and a["key"] in (n1, n2)
            for other in (n2 if n1 == a["key"] else n1,)
            if other in cluster_map and cluster_map[other] != cluster_map.get(a["key"])
        }
        if len(fams) >= 2 or len(linked_clusters) >= 1:
            bridge_hubs.append({
                "name": a["name"],
                "families": fams[:3],
                "cross_cluster_links": len(linked_clusters),
                "score": a["score"],
            })
    bridge_hubs.sort(key=lambda x: (-(len(x["families"]) + x["cross_cluster_links"]), -x["score"]))

    # --- Artist -> Macro & Genres lookup ---
    artist_macro_map: dict[str, str] = {}
    artist_genres_map: dict[str, list[str]] = {}
    for key, a in artists.items():
        if a["genres"]:
            artist_genres_map[key] = a["genres"]
            artist_macro_map[key] = _macro_family(a["genres"][0])

    # --- Circadian Profile (4 dayparts + 24h curve + 7d curve + binge stats) ---
    total_dp_plays = sum(v["plays"] for v in daypart_stats.values()) or 1
    dayparts_out: dict[str, Any] = {}
    for dp, data in daypart_stats.items():
        durs = data["durations"]
        dayparts_out[dp] = {
            "plays": data["plays"],
            "share_pct": round((data["plays"] / total_dp_plays) * 100.0, 1) if data["plays"] else 0.0,
            "top_artists": [n for n, _c in data["artists"].most_common(5)],
            "avg_duration_sec": round(sum(durs) / len(durs), 1) if durs else None,
        }

    hourly_curve = []
    for hr in range(24):
        hst = hourly_stats[hr]
        fam_cnt: Counter[str] = Counter()
        for ak, cnt in hst["artists"].items():
            fam = artist_macro_map.get(ak)
            if fam:
                fam_cnt[fam] += cnt
        hourly_curve.append({
            "hour": hr,
            "plays": hst["plays"],
            "dominant_family": fam_cnt.most_common(1)[0][0] if fam_cnt else None,
        })

    weekday_curve = [
        {
            "day": DAYS_FR[wd],
            "plays": weekday_stats[wd]["plays"],
            "top_artist": weekday_stats[wd]["artists"].most_common(1)[0][0] if weekday_stats[wd]["artists"] else None,
        }
        for wd in range(7)
    ]

    peak_hour = hour_hist.most_common(1)[0][0] if hour_hist else None
    peak_day_idx = weekday_hist.most_common(1)[0][0] if weekday_hist else None
    try:
        import hq_music_journal as journal
        streak = journal._longest_streak(active_days)
    except Exception:  # noqa: BLE001
        streak = 0

    binge_profile = {
        "burst_sessions_1_3": sum(1 for ln in session_lengths_calc if ln <= 3),
        "standard_sessions_4_12": sum(1 for ln in session_lengths_calc if 4 <= ln <= 12),
        "marathon_sessions_13_plus": sum(1 for ln in session_lengths_calc if ln >= 13),
        "night_owl_pct": round(night_owl_plays * 100.0 / len(j_plays), 1) if j_plays else 0.0,
    }

    circadian_profile = {
        "dayparts": dayparts_out,
        "hourly_curve": hourly_curve,
        "weekday_curve": weekday_curve,
        "weekday_vs_weekend": {
            "weekday_plays": weekday_plays,
            "weekend_plays": weekend_plays,
            "weekday_top_artists": [n for n, _c in weekday_artists.most_common(5)],
            "weekend_top_artists": [n for n, _c in weekend_artists.most_common(5)],
        },
        "binge_profile": binge_profile,
        "peak_hour": peak_hour,
        "peak_weekday": DAYS_FR[peak_day_idx] if peak_day_idx is not None else None,
        "active_days": len(active_days),
        "longest_streak": streak,
        "avg_plays_per_active_day": round(len(j_plays) / len(active_days), 1) if active_days else 0.0,
    }

    # --- Acoustic, Structural & Era Fingerprint ---
    pops = [t["popularity"] for t in track_pool_for_stats if isinstance(t.get("popularity"), int)]
    if not pops:
        pops = [a["popularity"] for a in scored_artists if isinstance(a.get("popularity"), int)]
    mainstream_idx = round(sum(pops) / len(pops), 1) if pops else None
    if mainstream_idx is None:
        mainstream_label = "unknown"
    elif mainstream_idx < 38:
        mainstream_label = "underground_niche"
    elif mainstream_idx < 56:
        mainstream_label = "eclectic_curator"
    elif mainstream_idx < 72:
        mainstream_label = "balanced"
    else:
        mainstream_label = "mainstream"

    years = []
    for t in track_pool_for_stats:
        y = t.get("year")
        if isinstance(y, str) and y.isdigit() and 1940 <= int(y) <= 2035:
            years.append(int(y))
    for rit in radar_items:
        y = rit.get("year")
        if isinstance(y, str) and y.isdigit() and 1940 <= int(y) <= 2035:
            years.append(int(y))
    years.sort()
    era_dist = {"decade_2020s": 0.0, "decade_2010s": 0.0, "decade_2000s": 0.0, "classic_pre_2000": 0.0}
    era_timeline = {
        "y2025_plus": 0.0, "y2022_2024": 0.0, "y2018_2021": 0.0,
        "y2010_2017": 0.0, "y2000_2009": 0.0, "pre_2000": 0.0,
    }
    if years:
        n_y = len(years)
        era_dist = {
            "decade_2020s": round(sum(1 for y in years if y >= 2020) * 100.0 / n_y, 1),
            "decade_2010s": round(sum(1 for y in years if 2010 <= y < 2020) * 100.0 / n_y, 1),
            "decade_2000s": round(sum(1 for y in years if 2000 <= y < 2010) * 100.0 / n_y, 1),
            "classic_pre_2000": round(sum(1 for y in years if y < 2000) * 100.0 / n_y, 1),
        }
        era_timeline = {
            "y2025_plus": round(sum(1 for y in years if y >= 2025) * 100.0 / n_y, 1),
            "y2022_2024": round(sum(1 for y in years if 2022 <= y <= 2024) * 100.0 / n_y, 1),
            "y2018_2021": round(sum(1 for y in years if 2018 <= y <= 2021) * 100.0 / n_y, 1),
            "y2010_2017": round(sum(1 for y in years if 2010 <= y <= 2017) * 100.0 / n_y, 1),
            "y2000_2009": round(sum(1 for y in years if 2000 <= y <= 2009) * 100.0 / n_y, 1),
            "pre_2000": round(sum(1 for y in years if y < 2000) * 100.0 / n_y, 1),
        }
    median_year = years[len(years) // 2] if years else None

    durs = [t["duration_ms"] / 1000.0 for t in track_pool_for_stats if isinstance(t.get("duration_ms"), (int, float)) and t["duration_ms"] > 0]
    for _d, _l, row in j_plays:
        if isinstance(row.get("d"), (int, float)) and row["d"] > 0:
            durs.append(float(row["d"]) / 1000.0)
    dur_profile: dict[str, Any] = {}
    if durs:
        n_d = len(durs)
        dur_profile = {
            "short_under_150s_pct": round(sum(1 for d in durs if d < 150) * 100.0 / n_d, 1),
            "standard_150_270s_pct": round(sum(1 for d in durs if 150 <= d <= 270) * 100.0 / n_d, 1),
            "epic_over_270s_pct": round(sum(1 for d in durs if d > 270) * 100.0 / n_d, 1),
            "avg_sec": round(sum(durs) / n_d, 1),
        }

    explicits = [t["explicit"] for t in track_pool_for_stats if isinstance(t.get("explicit"), bool)]
    explicit_ratio = round(sum(1 for e in explicits if e) / len(explicits), 3) if explicits else None

    exploration_index = None
    if play_artist_counter and len(play_artist_counter) > 1:
        tot_p = sum(play_artist_counter.values())
        entropy = -sum((c / tot_p) * math.log(c / tot_p) for c in play_artist_counter.values() if c > 0)
        max_ent = math.log(len(play_artist_counter))
        exploration_index = round(entropy / max_ent, 3) if max_ent > 0 else 0.0

    beats_doc = music._load("musica_beats.json", {"grids": {}})
    grids = beats_doc.get("grids") if isinstance(beats_doc.get("grids"), dict) else {}
    bpms = sorted(float(g["bpm"]) for g in grids.values() if isinstance(g, dict) and isinstance(g.get("bpm"), (int, float)))
    bpm_profile: dict[str, Any] = {"measured_tracks": len(bpms)}
    if bpms:
        n_b = len(bpms)
        bpm_profile.update({
            "avg_bpm": round(sum(bpms) / n_b, 1),
            "median_bpm": round(bpms[n_b // 2], 1),
            "min_bpm": round(bpms[0], 1),
            "max_bpm": round(bpms[-1], 1),
            "tempo_bands": {
                "slow_under_100": round(sum(1 for b in bpms if b < 100) * 100.0 / n_b, 1),
                "mid_100_130": round(sum(1 for b in bpms if 100 <= b < 130) * 100.0 / n_b, 1),
                "fast_130_160": round(sum(1 for b in bpms if 130 <= b < 160) * 100.0 / n_b, 1),
                "hyper_over_160": round(sum(1 for b in bpms if b >= 160) * 100.0 / n_b, 1),
            },
        })

    version_tags = ("slowed", "reverb", "sped up", "nightcore", "remix", "live", "acoustic", "instrumental", "remaster")
    version_counts: Counter[str] = Counter()
    for t in track_pool_for_stats:
        tname = str(t.get("name") or "").casefold()
        for tag in version_tags:
            if tag in tname:
                version_counts[tag] += 1
    for _d, _l, row in j_plays:
        tname = str(row.get("n") or "").casefold()
        for tag in version_tags:
            if tag in tname:
                version_counts[tag] += 1

    j_tracks_idx = j_index.get("tracks") if isinstance(j_index.get("tracks"), dict) else {}
    obsessed_tracks = sorted(
        (
            {
                "name": str(v.get("name") or ""),
                "artists": list(v.get("artists") or []),
                "count": int(v.get("count") or 0),
                "last": v.get("last"),
            }
            for v in j_tracks_idx.values()
            if isinstance(v, dict) and v.get("name") and int(v.get("count") or 0) >= 2
        ),
        key=lambda x: (-x["count"], x["name"]),
    )[:12]
    total_idx_plays = sum(int(v.get("count") or 0) for v in j_tracks_idx.values() if isinstance(v, dict))
    repeat_ratio = round(1.0 - (len(j_tracks_idx) / total_idx_plays), 3) if total_idx_plays > 0 else None

    artist_concentration_top5_pct = None
    if play_artist_counter:
        tot_pa = sum(play_artist_counter.values())
        top5_pa = sum(c for _k, c in play_artist_counter.most_common(5))
        artist_concentration_top5_pct = round(top5_pa * 100.0 / tot_pa, 1) if tot_pa > 0 else None

    acoustic_fingerprint = {
        "mainstream_index": mainstream_idx,
        "mainstream_label": mainstream_label,
        "era_distribution": era_dist,
        "era_timeline": era_timeline,
        "median_year": median_year,
        "duration_profile": dur_profile,
        "explicit_ratio": explicit_ratio,
        "saved_albums_count": len(sp.get("saved_albums") or []),
        "saved_tracks_count": len(sp.get("saved_tracks") or []),
        "recent_likes_30d": recent_likes_30d,
        "recent_likes_90d": recent_likes_90d,
        "exploration_index": exploration_index,
        "repeat_ratio": repeat_ratio,
        "artist_concentration_top5_pct": artist_concentration_top5_pct,
        "version_preferences": dict(version_counts.most_common(8)),
        "top_obsessed_tracks": obsessed_tracks,
        "bpm_profile": bpm_profile,
    }

    # --- Track Signatures, Album Architecture & Collaboration Network ---
    scored_tracks = sorted(
        (
            {
                "name": tr["name"],
                "artists": tr["artists"],
                "album": tr["album"],
                "duration_sec": round(tr["duration_ms"] / 1000.0) if tr["duration_ms"] else None,
                "year": tr["year"],
                "popularity": tr["popularity"],
                "score": round(tr["score"], 2),
                "journal_plays": tr["journal_plays"],
                "saved": tr["saved"],
                "tournament_wins": tr["tournament_wins"],
                "tournament_titles": tr["tournament_titles"],
                "sources": sorted(tr["sources"]),
            }
            for tr in track_ledger.values()
            if tr["score"] > 0 and tr["artists"][0].casefold() not in banned_keys
        ),
        key=lambda x: (-x["score"], -x["journal_plays"], x["name"]),
    )
    hidden_gems = [
        tr for tr in scored_tracks
        if (tr.get("popularity") is not None and tr["popularity"] <= 42)
        or "deep_cuts" in (track_ledger.get(f"{tr['artists'][0].casefold()}||{tr['name'].casefold()}", {}).get("pools") or set())
    ][:12]

    track_signatures = {
        "top_tracks": scored_tracks[:25],
        "hidden_gems": hidden_gems,
        "pinned_tracks": list(overrides.get("pinned_tracks") or []),
    }

    albums_out = sorted(
        (
            {
                "album": al["album"],
                "artist": al["artist"],
                "year": al["year"],
                "saved": al["saved"],
                "distinct_tracks": len(al["tracks"]),
                "plays": al["plays"],
                "score": round(al["score"], 2),
            }
            for al in album_ledger.values()
            if al["artist"].casefold() not in banned_keys
        ),
        key=lambda x: (-x["score"], -x["distinct_tracks"], x["album"]),
    )[:15]
    multi_track_albums = sum(1 for al in album_ledger.values() if len(al["tracks"]) >= 3)
    saved_alb_n = len(sp.get("saved_albums") or [])
    if saved_alb_n >= 12 and multi_track_albums >= 6:
        listening_style = "album_devotee"
    elif (saved_alb_n >= 4 or multi_track_albums >= 4) and len(playlist_archetypes) >= 3:
        listening_style = "hybrid_curator"
    elif len(playlist_archetypes) >= 3:
        listening_style = "playlist_curator"
    else:
        listening_style = "single_hunter"
    album_architecture = {
        "listening_style": listening_style,
        "saved_albums_count": len(sp.get("saved_albums") or []),
        "multi_track_albums_count": multi_track_albums,
        "top_albums": albums_out[:12],
    }

    hub_counter: Counter[str] = Counter()
    top_collaborations = []
    for (k1, k2), cnt in collab_pairs.most_common(15):
        n1, n2 = collab_names.get(k1, k1), collab_names.get(k2, k2)
        hub_counter[n1] += cnt
        hub_counter[n2] += cnt
        top_collaborations.append({"artists": [n1, n2], "tracks": cnt})
    collaboration_network = {
        "top_collaborations": top_collaborations,
        "hub_artists": [{"name": n, "collab_tracks": c} for n, c in hub_counter.most_common(10)],
    }

    # --- Behavioral Signals ---
    pools = dj_state.get("pool_stats") if isinstance(dj_state.get("pool_stats"), dict) else {}
    pool_rates = {
        k: round((v.get("done", 0) + 1) / (v.get("done", 0) + v.get("skipped", 0) + 2), 3)
        for k, v in pools.items() if isinstance(v, dict)
    }
    behavioral_signals = {
        "liked_pools": [k for k, r in sorted(pool_rates.items(), key=lambda kv: -kv[1]) if r >= 0.6][:5],
        "skipped_pools": [k for k, r in sorted(pool_rates.items(), key=lambda kv: kv[1]) if r <= 0.35][:4],
        "pool_completion_rates": pool_rates,
        "recent_steers": [s.get("text") for s in (dj_state.get("steers") or []) if isinstance(s, dict) and s.get("text")][-10:],
        "banned_artists": list(taste.get("banned_artists") or []),
        "auto_excluded": list(taste.get("auto_excluded") or []),
    }

    prev_doc = _load_analysis()
    ai_synthesis = prev_doc.get("ai_synthesis") if isinstance(prev_doc.get("ai_synthesis"), dict) else None

    # --- Deep 6 Core Advanced Layers ---
    session_flow = _compute_session_flow(j_plays, artist_macro_map)
    lyrical_profile = _compute_lyrical_profile(track_pool_for_stats, artist_genres_map)
    fatigue_profile = _compute_fatigue_profile(artists, cooling_artists, banned_keys, track_ledger, feedback_rejects)
    calendar_correlation = _compute_calendar_correlation(j_plays, artist_macro_map, now)
    novelty_profile = _compute_novelty_profile(dj_state, taste, overrides)

    # --- Sonic Axes & Paradoxes ---
    sonic_axes = _compute_sonic_axes(macro_families, acoustic_fingerprint, circadian_profile, lyrical_profile, session_flow)
    taste_paradoxes = _detect_taste_paradoxes(macro_families, dur_profile, circadian_profile, acoustic_fingerprint, session_flow)

    # Deterministic narrative summary
    top_names = [a["name"] for a in scored_artists[:5]]
    top_fam = [f"{f['family']} ({f['share_pct']}%)" for f in macro_families[:3]]
    summary_parts = []
    if top_fam:
        summary_parts.append("Familles dominantes : " + ", ".join(top_fam) + ".")
    if top_names:
        summary_parts.append("Piliers : " + ", ".join(top_names) + ".")
    if surging_genres:
        summary_parts.append("En montée : " + ", ".join(surging_genres[:4]) + ".")
    if sonic_constellations:
        summary_parts.append(f"{len(sonic_constellations)} constellations sonores détectées.")
    if acoustic_fingerprint.get("artist_concentration_top5_pct") is not None:
        summary_parts.append(f"Top 5 artistes = {acoustic_fingerprint['artist_concentration_top5_pct']}% du volume.")

    clean_affinities = [{k: v for k, v in a.items() if k != "key"} for a in scored_artists[:80]]

    dossier: dict[str, Any] = {
        "version": 2,
        "analyzed_utc": _utcnow(),
        "raw_fetched_utc": raw.get("fetched_utc"),
        "history_sharing": True,
        "source_coverage": {
            "spotify_connected": bool(raw.get("spotify_connected")),
            "spotify_tracks_scanned": len(track_pool_for_stats),
            "spotify_playlists_scanned": len(playlist_archetypes),
            "dj_dig_cache_tracks": dig_tracks_count,
            "radar_releases_tracked": len(radar_items),
            "tournament_matches_played": sum(s["wins"] for s in (tournaments.get("songs") or {}).values()),
            "artist_genres_cached": sum(1 for v in meta_by_name.values() if v.get("genres")),
            "lyrics_cached_tracks": lyrical_profile.get("lyrics_cached_tracks", 0),
            "journal_plays": len(j_plays),
            "journal_days": len(active_days),
            "dj_signals_count": len(dj_state.get("artist_signal") or {}),
            "beat_grids_count": len(bpms),
            "taste_feedback_count": len(taste.get("loved") or []) + len(taste.get("rejected") or []) + len(profile_doc.get("feedback_history") or []),
        },
        "artist_affinities": clean_affinities,
        "cooling_and_rejected": cooling_artists[:25],
        "genre_profile": {
            "top_genres": top_genres,
            "macro_families": macro_families,
            "surging_genres": surging_genres,
            "manual_genres": sorted(manual_genre_keys),
        },
        "sonic_axes": sonic_axes,
        "sonic_constellations": sonic_constellations[:10],
        "bridge_hubs": bridge_hubs[:10],
        "track_signatures": track_signatures,
        "album_architecture": album_architecture,
        "collaboration_network": collaboration_network,
        "circadian_profile": circadian_profile,
        "acoustic_fingerprint": acoustic_fingerprint,
        "playlist_archetypes": playlist_archetypes,
        "behavioral_signals": behavioral_signals,
        "session_flow": session_flow,
        "lyrical_profile": lyrical_profile,
        "fatigue_profile": fatigue_profile,
        "calendar_correlation": calendar_correlation,
        "novelty_profile": novelty_profile,
        "tournament_intelligence": {
            "tournaments_played": tournaments["tournaments_played"],
            "rivalry": tournaments["rivalry"],
            "top_songs": tournaments["top_songs"][:8],
            "top_artists": tournaments["top_artists"][:8],
            "recent_champions": tournaments["recent_champions"][-5:],
        },
        "taste_paradoxes": taste_paradoxes,
        "custom_notes": overrides.get("custom_notes") or "",
        "taste_summary_text": " ".join(summary_parts) or "Profil en attente de données.",
        "ai_synthesis": ai_synthesis,
    }
    dossier["drift_profile"] = _record_and_compute_drift(dossier, j_plays, j_artists_idx, now)
    dossier["actionable_recipes"] = _build_actionable_recipes(dossier, overrides)
    _save_analysis(dossier)
    return dossier


# ---------------------------------------------------------------------------
# 5. Optional AI Deep Synthesis (Comprehensive Musicological Payload)
# ---------------------------------------------------------------------------

def synthesize_with_ai(analysis: dict[str, Any] | None = None) -> dict[str, Any] | None:
    """Ask hq_ai to synthesize deep psychological threads, paradoxes, bridges, and mood rules."""
    if not music.get_taste().get("history_sharing", True):
        return None
    analysis = analysis if isinstance(analysis, dict) else _load_analysis()
    if not analysis or not analysis.get("artist_affinities"):
        return None
    try:
        import hq_ai
    except Exception:  # noqa: BLE001
        return None

    overrides = get_overrides()
    compact = {
        "top_artists": [
            {"name": a["name"], "tier": a["tier"], "trajectory": a["trajectory"], "genres": a["genres"][:3], "country": a.get("country")}
            for a in (analysis.get("artist_affinities") or [])[:22]
        ],
        "macro_families": (analysis.get("genre_profile") or {}).get("macro_families", [])[:8],
        "surging_genres": (analysis.get("genre_profile") or {}).get("surging_genres", [])[:8],
        "sonic_axes": {k: v.get("score") for k, v in (analysis.get("sonic_axes") or {}).items() if isinstance(v, dict)},
        "constellations": [
            {"label": c["label"], "weight_pct": c["weight_pct"], "artists": c["artists"][:5]}
            for c in (analysis.get("sonic_constellations") or [])[:6]
        ],
        "bridge_hubs": (analysis.get("bridge_hubs") or [])[:5],
        "top_tracks": [
            f"{t['artists'][0]} - {t['name']} ({t.get('journal_plays', 0)}x)"
            for t in ((analysis.get("track_signatures") or {}).get("top_tracks") or [])[:10]
            if t.get("artists")
        ],
        "circadian": {
            "dayparts": {
                dp: v.get("top_artists", [])[:3]
                for dp, v in ((analysis.get("circadian_profile") or {}).get("dayparts") or {}).items()
                if v.get("plays")
            },
            "binge": (analysis.get("circadian_profile") or {}).get("binge_profile"),
            "peak_hour": (analysis.get("circadian_profile") or {}).get("peak_hour"),
        },
        "acoustic": {
            k: (analysis.get("acoustic_fingerprint") or {}).get(k)
            for k in ("mainstream_index", "mainstream_label", "median_year", "duration_profile", "bpm_profile", "version_preferences", "exploration_index", "repeat_ratio")
        },
        "playlists": [
            {"name": p["name"], "archetype": p["archetype"], "genres": p["top_genres"][:2]}
            for p in (analysis.get("playlist_archetypes") or [])[:10]
        ],
        "session_flow": analysis.get("session_flow"),
        "lyrical_profile": analysis.get("lyrical_profile"),
        "fatigue_profile": {
            "overplay": [x["name"] for x in ((analysis.get("fatigue_profile") or {}).get("overplay_fatigue") or [])[:5]],
            "dislikes": [x["name"] for x in ((analysis.get("fatigue_profile") or {}).get("true_dislikes") or [])[:5]],
        },
        "novelty_profile": analysis.get("novelty_profile"),
        "tournament_champions": ((analysis.get("tournament_intelligence") or {}).get("recent_champions") or [])[-4:],
        "paradoxes": analysis.get("taste_paradoxes"),
        "manual_overrides": {
            "boosted_artists": overrides.get("boosted_artists"),
            "boosted_genres": overrides.get("boosted_genres"),
            "custom_notes": overrides.get("custom_notes"),
            "mood_rules_override": overrides.get("mood_rules_override"),
            "target_bpm_range": overrides.get("target_bpm_range"),
        },
    }

    system = (
        "You are Musica, the elite musicologist and music steward of Transfert HQ. "
        "Analyze the Master's exhaustive 14-layer empirical listening dossier and output ONLY valid JSON with keys:\n"
        '{"archetype_title":"evocative 3-6 word musicological archetype title in French",'
        '"narrative_summary":"3-4 sharp sentences in French explaining his musical DNA, how his disparate scenes connect, and what drives his listening",'
        '"psychological_threads":["4-5 sharp psychological/sonic threads"],'
        '"sonic_paradoxes":["2-3 fascinating dualities observed in his taste"],'
        '"blind_spots_and_bridges":["4-5 concrete bridge micro-genres or artist intersections to explore next"],'
        '"mood_rules":{"matin":"...","apres-midi":"...","soiree":"...","nuit":"...","sport":"...","focus":"..."},'
        '"curator_warnings":["1-3 actionable alerts on fatigue, overplay, or blind spots"]}'
    )
    contents = [{"role": "user", "parts": [{"text": json.dumps(compact, ensure_ascii=False)}]}]
    try:
        chain = getattr(hq_ai, "ASK_CHAIN", None) or getattr(hq_ai, "CHAT_CHAIN", ())
        text, model_used = hq_ai.generate(
            chain,
            system,
            contents,
            json_out=True,
            temperature=0.35,
            max_tokens=1600,
        )
        parsed = hq_ai.extract_json(text)
    except Exception:  # noqa: BLE001
        return None

    if not isinstance(parsed, dict) or not parsed.get("narrative_summary"):
        return None

    synthesis = {
        "archetype_title": str(parsed.get("archetype_title") or "")[:120] or None,
        "narrative_summary": str(parsed.get("narrative_summary") or "")[:900],
        "psychological_threads": [str(x)[:220] for x in (parsed.get("psychological_threads") or []) if x][:6],
        "sonic_paradoxes": [str(x)[:220] for x in (parsed.get("sonic_paradoxes") or []) if x][:4],
        "blind_spots_and_bridges": [str(x)[:220] for x in (parsed.get("blind_spots_and_bridges") or []) if x][:6],
        "mood_rules": {
            str(k): str(v)[:240]
            for k, v in (parsed.get("mood_rules") or {}).items()
            if k and v
        },
        "curator_warnings": [str(x)[:220] for x in (parsed.get("curator_warnings") or []) if x][:4],
        "synthesized_utc": _utcnow(),
        "model": str(model_used or "unknown"),
    }
    analysis["ai_synthesis"] = synthesis
    _save_analysis(analysis)
    return synthesis


# ---------------------------------------------------------------------------
# 6. Sync Back to hq_music.profile (Preserving Manual Overrides) & Runner
# ---------------------------------------------------------------------------

def sync_music_preferences(analysis: dict[str, Any] | None = None) -> dict[str, Any]:
    """Merge analyzed pillars/genres/patterns into hq_music profile without clobbering manual picks."""
    analysis = analysis if isinstance(analysis, dict) else _load_analysis()
    if not analysis or not analysis.get("history_sharing", True):
        return music.get_profile()

    existing = music.get_profile()
    overrides = get_overrides()
    banned = {b.casefold() for b in (music.get_taste().get("banned_artists") or [])}

    def merge_unique(*lists: list[str], limit: int) -> list[str]:
        out: list[str] = []
        seen: set[str] = set()
        for lst in lists:
            for item in lst:
                val = str(item or "").strip()[:80]
                if not val:
                    continue
                cf = val.casefold()
                if cf not in seen:
                    seen.add(cf)
                    out.append(val)
                    if len(out) >= limit:
                        return out
        return out

    analyzed_artists = [
        a["name"]
        for a in (analysis.get("artist_affinities") or [])[:25]
        if isinstance(a, dict) and a.get("name") and a["name"].casefold() not in banned
    ]
    fav_artists = merge_unique(
        overrides.get("boosted_artists") or [],
        existing.get("favorite_artists") or [],
        analyzed_artists,
        limit=30,
    )

    analyzed_genres = [
        g["genre"]
        for g in ((analysis.get("genre_profile") or {}).get("top_genres") or [])[:20]
        if isinstance(g, dict) and g.get("genre")
    ]
    top_genres = merge_unique(
        overrides.get("boosted_genres") or [],
        existing.get("preferred_genres") or [],
        analyzed_genres,
        limit=25,
    )

    derived_patterns: list[str] = []
    for c in (analysis.get("sonic_constellations") or [])[:5]:
        if c.get("label"):
            derived_patterns.append(f"constellation: {c['label']}")
    for sg in ((analysis.get("genre_profile") or {}).get("surging_genres") or [])[:4]:
        derived_patterns.append(f"surging: {sg}")
    ac = analysis.get("acoustic_fingerprint") or {}
    if ac.get("mainstream_label") and ac["mainstream_label"] != "unknown":
        derived_patterns.append(f"taste_tier: {ac['mainstream_label']}")
    if ac.get("median_year"):
        derived_patterns.append(f"median_era: {ac['median_year']}")
    # Keep user-authored patterns while refreshing computed system tags
    manual_patterns = [
        p for p in (existing.get("musical_patterns") or [])
        if isinstance(p, str) and not p.startswith(("constellation: ", "surging: ", "taste_tier: ", "median_era: "))
    ]
    patterns = merge_unique(manual_patterns, derived_patterns, limit=25)

    updates: dict[str, Any] = {}
    if fav_artists:
        updates["favorite_artists"] = fav_artists
    if top_genres:
        updates["preferred_genres"] = top_genres
    if patterns:
        updates["musical_patterns"] = patterns
    if not updates:
        return existing
    return music.update_preferences(updates)


def run_full_pipeline(
    *,
    deep: bool = True,
    force: bool = False,
    synthesize: bool = True,
    sync_preferences: bool = True,
) -> dict[str, Any]:
    """Run fetch -> analyze -> optional AI synthesis -> optional profile sync."""
    def progress(stage: str, pct: int, label: str) -> None:
        _set_job(stage=stage, pct=pct, label=label)

    _set_job(running=True, stage="starting", pct=5, label="Initialisation de l'analyse approfondie…",
             error=None, started_utc=_utcnow(), finished_utc=None)
    try:
        raw = fetch_raw_profile(deep=deep, force=force, progress_cb=progress)
        progress("analyzing", 68, "Calcul des 14 dimensions, axes sonores et trajectoires…")
        analysis = analyze_profile(raw=raw)
        if synthesize and analysis.get("history_sharing") and analysis.get("artist_affinities"):
            progress("synthesizing", 84, "Synthèse musicologique par Musica…")
            synthesize_with_ai(analysis)
        if sync_preferences and analysis.get("history_sharing"):
            progress("syncing", 95, "Synchronisation des préférences HQ…")
            sync_music_preferences(analysis)
        _set_job(running=False, stage="done", pct=100, label="Profil musical complet à jour.",
                 error=None, finished_utc=_utcnow())
        return {
            "ok": True,
            "analysis": _load_analysis() or analysis,
            "fetch_state": get_fetch_status(),
        }
    except Exception as exc:  # noqa: BLE001
        _set_job(running=False, stage="error", pct=0, label=str(exc)[:160],
                 error=str(exc)[:160], finished_utc=_utcnow())
        raise


def start_fetch_job(
    *,
    deep: bool = True,
    force: bool = True,
    synthesize: bool = True,
    sync_preferences: bool = True,
) -> dict[str, Any]:
    """Start the full pipeline in a background daemon thread (safe under 15s browser timeout)."""
    with _job_lock:
        if _job_state["running"]:
            return {"ok": True, "already_running": True, "fetch_state": dict(_job_state)}
        _job_state.update({
            "running": True,
            "stage": "starting",
            "pct": 5,
            "label": "Initialisation de l'analyse approfondie…",
            "error": None,
            "started_utc": _utcnow(),
            "finished_utc": None,
        })

    def worker() -> None:
        try:
            run_full_pipeline(deep=deep, force=force, synthesize=synthesize, sync_preferences=sync_preferences)
        except Exception:  # noqa: BLE001
            pass

    threading.Thread(target=worker, name="musica-profile-fetch", daemon=True).start()
    return {"ok": True, "started": True, "fetch_state": get_fetch_status()}


def tick(*, now: datetime | None = None) -> None:
    """Background bridge hook: refresh local taste analysis + drift snapshot at most once every 24h."""
    try:
        if not music.get_taste().get("history_sharing", True):
            return
        now = now or datetime.now(timezone.utc)
        doc = _load_analysis()
        last_dt = _parse_dt(doc.get("analyzed_utc"))
        if last_dt is not None and (now - last_dt).total_seconds() < TICK_INTERVAL_SEC:
            return
        analyze_profile(now=now)
    except Exception:  # noqa: BLE001
        pass


# ---------------------------------------------------------------------------
# 7. Musica Brain & Tool Integration
# ---------------------------------------------------------------------------

def get_profile_dossier(*, auto_analyze_local: bool = True) -> dict[str, Any]:
    """Return the analyzed dossier, computing from local signals if none exists or outdated."""
    sharing = music.get_taste().get("history_sharing", True)
    overrides = get_overrides()
    if not sharing:
        return {
            "ok": True,
            "history_sharing": False,
            "analysis": None,
            "overrides": overrides,
            "fetch_state": get_fetch_status(),
        }
    doc = _load_analysis()
    if (not doc or not doc.get("analyzed_utc") or int(doc.get("version") or 1) < 2) and auto_analyze_local:
        doc = analyze_profile()
    return {
        "ok": True,
        "history_sharing": True,
        "analysis": doc or None,
        "overrides": overrides,
        "fetch_state": get_fetch_status(),
    }


def prompt_dossier(*, max_chars: int = 2000) -> str:
    """Compact token-budgeted taste dossier for Musica's system prompt."""
    if not music.get_taste().get("history_sharing", True):
        return ""
    doc = _load_analysis()
    if not doc or not doc.get("analyzed_utc") or int(doc.get("version") or 1) < 2:
        try:
            doc = analyze_profile()
        except Exception:  # noqa: BLE001
            return ""
    if not doc or not doc.get("artist_affinities"):
        return ""

    overrides = get_overrides()
    lines: list[str] = ["MASTER DEEP TASTE DOSSIER (empirical, do not invent beyond this):"]
    ai_syn = doc.get("ai_synthesis") if isinstance(doc.get("ai_synthesis"), dict) else {}
    if ai_syn.get("archetype_title"):
        lines.append(f"Archetype: {ai_syn['archetype_title']}")

    families = (doc.get("genre_profile") or {}).get("macro_families") or []
    if families:
        lines.append("Sonic families: " + ", ".join(f"{f['family']} ({f['share_pct']}%)" for f in families[:5]))
    top_g = (doc.get("genre_profile") or {}).get("top_genres") or []
    if top_g:
        lines.append("Top subgenres: " + ", ".join(g["genre"] for g in top_g[:8]))
    surging_g = (doc.get("genre_profile") or {}).get("surging_genres") or []
    if surging_g:
        lines.append("Surging genres: " + ", ".join(surging_g[:5]))

    axes = doc.get("sonic_axes") or {}
    if axes:
        ax_bits = [f"{k.split('_')[0]}={v.get('score')}" for k, v in axes.items() if isinstance(v, dict)]
        if ax_bits:
            lines.append("Sonic axes (0-100): " + ", ".join(ax_bits))

    pillars = [a["name"] for a in doc["artist_affinities"] if a.get("tier") == "core_pillar"][:6]
    obsessions = [a["name"] for a in doc["artist_affinities"] if a.get("trajectory") in {"surging", "climbing"}][:5]
    if pillars:
        lines.append("Core pillars: " + ", ".join(pillars))
    if obsessions:
        lines.append("Rising/surging artists: " + ", ".join(obsessions))
    if overrides.get("boosted_artists"):
        lines.append("Boosted artists: " + ", ".join(overrides["boosted_artists"][:6]))

    top_tracks = ((doc.get("track_signatures") or {}).get("top_tracks") or [])[:4]
    if top_tracks:
        lines.append("Signature tracks: " + "; ".join(f"{t['artists'][0]} - {t['name']}" for t in top_tracks if t.get("artists")))

    dp = (doc.get("circadian_profile") or {}).get("dayparts") or {}
    dp_bits = [f"{k}: {', '.join(v['top_artists'][:2])}" for k, v in dp.items() if v.get("top_artists")]
    if dp_bits:
        lines.append("Dayparts: " + " | ".join(dp_bits))

    ac = doc.get("acoustic_fingerprint") or {}
    ac_bits = []
    if ac.get("mainstream_label") and ac["mainstream_label"] != "unknown":
        ac_bits.append(f"tier={ac['mainstream_label']}")
    if ac.get("median_year"):
        ac_bits.append(f"median_year={ac['median_year']}")
    if (ac.get("bpm_profile") or {}).get("median_bpm"):
        ac_bits.append(f"median_bpm={ac['bpm_profile']['median_bpm']}")
    bpm_ov = overrides.get("target_bpm_range") or {}
    if bpm_ov.get("min") or bpm_ov.get("max"):
        ac_bits.append(f"target_bpm={bpm_ov.get('min') or '?'}-{bpm_ov.get('max') or '?'}")
    nov = doc.get("novelty_profile") or {}
    if nov.get("optimal_familiarity") is not None:
        ac_bits.append(f"familiarity={nov.get('manual_target_familiarity') or nov['optimal_familiarity']}")
    if ac_bits:
        lines.append("Fingerprint: " + ", ".join(ac_bits))

    lp = doc.get("lyrical_profile") or {}
    if lp.get("languages"):
        lines.append("Languages: " + ", ".join(f"{k}:{v}%" for k, v in list(lp["languages"].items())[:4]))
    fp = doc.get("fatigue_profile") or {}
    if fp.get("overplay_fatigue"):
        lines.append("Overplay fatigue (rest 14d): " + ", ".join(x["name"] for x in fp["overplay_fatigue"][:4]))

    mood_ov = overrides.get("mood_rules_override") or {}
    if mood_ov:
        lines.append("Mood rules override: " + " | ".join(f"{k}={v}" for k, v in mood_ov.items())[:260])

    if ai_syn.get("narrative_summary"):
        lines.append("Synthesis: " + str(ai_syn["narrative_summary"]))
    notes = str(doc.get("custom_notes") or overrides.get("custom_notes") or "").strip()
    if notes:
        lines.append("Master directives: " + notes[:350])

    return "\n".join(lines)[:max_chars]


def query_dossier(section: str = "overview") -> dict[str, Any]:
    """Tool entrypoint for Musica (`my_taste_profile`) to inspect any of the 14 taste dimensions."""
    if not music.get_taste().get("history_sharing", True):
        return {"ok": False, "error": "History sharing is disabled."}
    dossier = get_profile_dossier(auto_analyze_local=True).get("analysis") or {}
    sec = str(section or "overview").strip().casefold()

    section_map: dict[str, tuple[str, Any]] = {
        "axes": ("sonic_axes", dossier.get("sonic_axes")),
        "genres": ("genre_profile", dossier.get("genre_profile")),
        "clusters": ("sonic_constellations", dossier.get("sonic_constellations")),
        "tracks": ("track_signatures", dossier.get("track_signatures")),
        "albums": ("album_architecture", dossier.get("album_architecture")),
        "collabs": ("collaboration_network", dossier.get("collaboration_network")),
        "circadian": ("circadian_profile", dossier.get("circadian_profile")),
        "hourly": ("circadian_profile", dossier.get("circadian_profile")),
        "acoustic": ("acoustic_fingerprint", dossier.get("acoustic_fingerprint")),
        "playlists": ("playlist_archetypes", dossier.get("playlist_archetypes")),
        "flow": ("session_flow", dossier.get("session_flow")),
        "lyrics": ("lyrical_profile", dossier.get("lyrical_profile")),
        "fatigue": ("fatigue_profile", dossier.get("fatigue_profile")),
        "calendar": ("calendar_correlation", dossier.get("calendar_correlation")),
        "novelty": ("novelty_profile", dossier.get("novelty_profile")),
        "tournaments": ("tournament_intelligence", dossier.get("tournament_intelligence")),
        "paradoxes": ("taste_paradoxes", dossier.get("taste_paradoxes")),
        "recipes": ("actionable_recipes", dossier.get("actionable_recipes")),
        "drift": ("drift_profile", dossier.get("drift_profile")),
    }
    if sec in section_map:
        k, val = section_map[sec]
        return {"ok": True, "section": sec, k: val}

    if sec == "artists":
        return {
            "ok": True,
            "section": "artists",
            "top_artists": (dossier.get("artist_affinities") or [])[:30],
            "cooling_and_rejected": (dossier.get("cooling_and_rejected") or [])[:12],
        }
    if sec == "bridges":
        return {
            "ok": True,
            "section": "bridges",
            "ai_synthesis": dossier.get("ai_synthesis"),
            "bridge_hubs": dossier.get("bridge_hubs"),
            "taste_paradoxes": dossier.get("taste_paradoxes"),
            "surging_genres": (dossier.get("genre_profile") or {}).get("surging_genres"),
            "session_flow": dossier.get("session_flow"),
            "actionable_recipes": dossier.get("actionable_recipes"),
        }

    return {
        "ok": True,
        "section": "overview",
        "analyzed_utc": dossier.get("analyzed_utc"),
        "source_coverage": dossier.get("source_coverage"),
        "sonic_axes": dossier.get("sonic_axes"),
        "top_artists": [
            {"name": a["name"], "score": a["score"], "tier": a["tier"], "trajectory": a["trajectory"], "genres": a["genres"][:3]}
            for a in (dossier.get("artist_affinities") or [])[:15]
        ],
        "macro_families": (dossier.get("genre_profile") or {}).get("macro_families", [])[:6],
        "surging_genres": (dossier.get("genre_profile") or {}).get("surging_genres", [])[:6],
        "sonic_constellations": (dossier.get("sonic_constellations") or [])[:5],
        "taste_paradoxes": dossier.get("taste_paradoxes"),
        "acoustic_fingerprint": dossier.get("acoustic_fingerprint"),
        "ai_synthesis": dossier.get("ai_synthesis"),
        "taste_summary_text": dossier.get("taste_summary_text"),
    }
