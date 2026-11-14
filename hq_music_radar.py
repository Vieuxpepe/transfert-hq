"""Spotify-backed new releases and exploration for Musique."""
from __future__ import annotations

from collections import Counter
from datetime import date, timedelta
import time
from typing import Any

import hq_music as music
import hq_spotify as spotify
import hq_state

RADAR_FILE = "radar.json"
EXPLORATION_FILE = "exploration.json"
MAX_ARTISTS = 25
RADAR_INTERVAL = 24 * 3600


def get_radar() -> dict[str, Any]:
    radar = music._load(RADAR_FILE, {"items": []})
    taste = music.get_taste()
    seen = set(taste["seen"])
    excluded = {a.casefold() for a in taste["banned_artists"] + taste["auto_excluded"]}
    radar["items"] = [item for item in radar["items"] if item.get("uri") not in seen
                      and not any(name.casefold() in excluded for name in item.get("artists") or [])]
    return radar


def _artist_seeds(taste: dict[str, Any]) -> list[str]:
    from hq_musica import listening_snapshot

    snapshot = listening_snapshot(refresh=True)
    remaining = snapshot.get("retry_at", 0) - time.time()
    if remaining > 0:
        raise spotify.SpotifyError("Spotify limite les requêtes", 429, "spotify_rate_limited",
                                   retry_after=max(1, round(remaining)))
    top = [a for artists in snapshot.get("top", {}).values() for a in artists]
    liked = [row.get("artist") for row in reversed(taste["loved"])]
    favorites = [row.get("name") for row in music.get_favorites()["artists"]]
    names = music.get_profile()["favorite_artists"] + favorites + top + liked
    excluded = {a.casefold() for a in taste["banned_artists"] + taste["auto_excluded"]}
    artists = {}
    for name in names:
        if name and name.casefold() not in excluded:
            artists.setdefault(name.casefold(), name)
    return list(artists.values())[:MAX_ARTISTS]


def run(*, force: bool = False) -> dict[str, Any]:
    with hq_state.path_lock(music._path(RADAR_FILE)):
        previous = get_radar()
        now = time.time()
        if previous.get("retry_at", 0) > now or (
            not force and now - previous.get("checked", 0) < RADAR_INTERVAL
        ):
            return previous
        taste = music.get_taste()
        seen = set(taste["seen"])
        today = date.today()
        earliest = (today - timedelta(days=30)).isoformat()
        items = {item["uri"]: item for item in previous["items"]
                 if earliest <= item.get("release_date", "") <= today.isoformat()}
        candidates = {}
        code = None
        retry_at = 0
        try:
            for artist in _artist_seeds(taste):
                field = spotify.field_query("artist", artist)
                for query in (f"{field} tag:new", f"{field} year:{today.year}"):
                    for album in spotify.search(query, types="album", retry_429=False)["albums"]:
                        uri = album.get("uri")
                        released = album.get("release_date") or ""
                        artists = {name.casefold() for name in album.get("artists") or []}
                        if (uri and uri not in seen and artist.casefold() in artists
                                and len(released) == 10 and earliest <= released <= today.isoformat()):
                            candidates.setdefault(uri, {**album, "kind": "album", "source_query": query,
                                                         "why": f"Sortie récente de {artist}"})
                    time.sleep(0.1)
            uris = list(dict.fromkeys([*items, *candidates]))
            for start in range(0, len(uris), 20):
                batch = uris[start:start + 20]
                for uri, saved in zip(batch, spotify.library_contains(batch, retry_429=False)):
                    if saved:
                        items.pop(uri, None)
                    elif uri in candidates:
                        items[uri] = candidates[uri]
        except spotify.SpotifyError as exc:
            if exc.status != 429 and exc.code != "spotify_unavailable_endpoint":
                raise
            code = exc.code
            if exc.status == 429:
                retry_at = time.time() + (exc.retry_after or 60)
        radar = {"checked": now, "retry_at": retry_at, "code": code,
                 "items": sorted(items.values(), key=lambda item: item["release_date"], reverse=True)[:80],
                 "notified": list(previous.get("notified") or [])[-400:]}
        radar["alerted"] = _alert_new_releases(radar, previous_uris={i.get("uri") for i in previous["items"]})
        music._write(RADAR_FILE, radar)
        return radar


def _alert_new_releases(radar: dict[str, Any], *, previous_uris: set[Any]) -> list[str]:
    """Ping once per new release when the Master switched release alerts on. Returns the URIs announced."""
    notified = set(radar.get("notified") or [])
    fresh = [item for item in radar["items"]
             if item.get("uri") and item["uri"] not in notified and item["uri"] not in previous_uris]
    if not fresh:
        return []
    radar["notified"] = (list(radar.get("notified") or []) + [item["uri"] for item in fresh])[-400:]
    try:
        import hq_music_dj
        hq_music_dj.note_releases(fresh)
    except Exception:  # noqa: BLE001 — the show is optional
        pass
    if not music.get_alerts()["releases"]:
        return []
    head = fresh[0]
    artist = ", ".join((head.get("artists") or [])[:2]) or "un artiste suivi"
    if len(fresh) == 1:
        title, body = f"Nouvelle sortie : {artist}", f"« {head.get('name') or '?'} » vient de sortir."
    else:
        title = f"{len(fresh)} nouvelles sorties"
        body = f"Dont « {head.get('name') or '?'} » de {artist}. Ouvre Musique › Découvertes."
    return [item["uri"] for item in fresh] if music.notify(title, body) else []


def tick() -> None:
    """Background hook: with release alerts on, refresh the radar at most once a day (``run`` guards it)."""
    try:
        if not music.get_alerts()["releases"]:
            return
        if not spotify.status().get("connected"):
            return
        run(force=False)
    except Exception:  # noqa: BLE001 — never break the bridge loop
        pass


def cooccurring_artists(playlists: list[list[dict[str, Any]]], *, excluded: set[str]) -> list[dict[str, Any]]:
    counts: Counter[str] = Counter()
    names: dict[str, str] = {}
    for tracks in playlists:
        found = {}
        for track in tracks:
            for name in track.get("artists") or []:
                if name.casefold() not in excluded:
                    found.setdefault(name.casefold(), name)
        names.update(found)
        counts.update(found.keys())
    return [{"name": names[key], "count": count} for key, count in counts.most_common(8)]


def discovery_tracks(seed: str, genre: str, *, limit: int = 15,
                     known_artists: tuple[str, ...] = ()) -> list[dict[str, Any]]:
    taste = music.get_taste()
    known = set(taste["seen"]) | {row.get("uri") for row in taste["loved"] + taste["rejected"]}
    banned = {a.casefold() for a in taste["banned_artists"] + taste["auto_excluded"]}
    excluded = banned | {a.casefold() for a in known_artists}
    tracks = {}

    def add(rows: list[dict[str, Any]], why: str) -> None:
        for track in rows:
            uri = track.get("uri")
            if uri and uri not in known and not any(a.casefold() in excluded for a in track.get("artists") or []):
                tracks.setdefault(uri, {**track, "why": why})

    # Album track rows carry the same Spotify evidence as the radar release.
    for album in get_radar()["items"][:3]:
        try:
            add(spotify.get_album(album["id"])["tracks"][:3], album["why"])
        except spotify.SpotifyError as exc:
            if exc.code != "spotify_unavailable_endpoint":
                raise
    if seed:
        samples = []
        playlists = spotify.search(seed, types="playlist", limit=5)["playlists"]
        for playlist in playlists:
            if not playlist.get("id"):
                continue
            try:
                sample = spotify.get_playlist_tracks(playlist["id"], limit=30)["items"]
            except spotify.SpotifyError as exc:
                if exc.code != "spotify_unavailable_endpoint":
                    raise
                continue
            if any(a.casefold() == seed.casefold() for row in sample for a in row.get("artists") or []):
                samples.append(sample)
        for candidate in cooccurring_artists(samples, excluded=excluded | {seed.casefold()}):
            name = candidate["name"]
            rows = spotify.search(spotify.field_query("artist", name), types="track", limit=3)["tracks"]
            add(rows, f"Présent dans {candidate['count']} playlist(s) avec {seed}")
            if len(tracks) >= limit:
                break
    if len(tracks) < limit:
        query = spotify.field_query("genre", genre)
        for offset in (0, 10):
            page = spotify.search(query, types="track", offset=offset)
            add(page["tracks"], f"Recherche Spotify dans le genre {genre}")
            if len(tracks) >= limit or page.get("next_offset") is None:
                break
    if len(tracks) < limit:
        # Spotify documents tag:hipster for albums only.
        page = spotify.search(f"{genre} tag:hipster", types="album", limit=4)
        for album in page["albums"]:
            try:
                add(spotify.get_album(album["id"])["tracks"][:3], "Album issu de la recherche Spotify tag:hipster")
            except spotify.SpotifyError as exc:
                if exc.code != "spotify_unavailable_endpoint":
                    raise
    if taste["history_sharing"]:
        uris = list(tracks)
        for start in range(0, len(uris), 20):
            batch = uris[start:start + 20]
            for uri, saved in zip(batch, spotify.library_contains(batch)):
                if saved:
                    del tracks[uri]
    return list(tracks.values())[:limit]


def explore(seed: str, genre: str) -> dict[str, Any]:
    with hq_state.path_lock(music._path(EXPLORATION_FILE)):
        rows = discovery_tracks(seed, genre, limit=12)
        if len(rows) < 10:
            raise music.MusicError("Il faut au moins dix découvertes vérifiées pour lancer l’exploration.",
                                   409, "not_enough_discoveries")
        playlist = spotify.create_playlist("Musica · Explorer", public=False)["playlist"]
        spotify.add_tracks(playlist["id"], [row["uri"] for row in rows])
        session = {"ok": True, "playlist": playlist, "tracks": rows}
        music._write(EXPLORATION_FILE, session)
        try:
            spotify.player_action("play", {"context_uri": playlist["uri"], "auto_device": True})
        except spotify.SpotifyError as exc:
            return {**session, "playing": False, "playback_code": exc.code}
        return {**session, "playing": True}


def save_keepers() -> dict[str, Any]:
    with hq_state.path_lock(music._path(EXPLORATION_FILE)):
        session = music._load(EXPLORATION_FILE, {})
        if session.get("keepers"):
            return {"ok": True, "playlist": session["keepers"]}
        loved = {row.get("uri") for row in music.get_taste()["loved"]}
        uris = [row["uri"] for row in session.get("tracks", []) if row.get("uri") in loved]
        if not uris:
            raise music.MusicError("Aime au moins un titre de l’exploration avant de sauver les gardés.")
        playlist = spotify.create_playlist("Musica · Gardés", public=False)["playlist"]
        spotify.add_tracks(playlist["id"], uris)
        session["keepers"] = playlist
        music._write(EXPLORATION_FILE, session)
        return {"ok": True, "playlist": playlist}


def activity_mix(activity: str, minutes: int, *, seed: str, genre: str, play: bool) -> dict[str, Any]:
    energetic = any(word in activity.casefold() for word in ("sport", "course", "workout", "gym"))
    minutes = min(180, max(10, minutes))
    target = max(3, round(minutes * 60 / 210))
    discovered = discovery_tracks(seed, genre, limit=max(15, target))
    sources = [{"name": "Découvertes Spotify", "weight": 3 if energetic else 2, "tracks": discovered}]
    playlists = music.get_favorites()["playlists"]
    if playlists:
        favorite = playlists[-1]
        sources.append({"playlist_id": favorite["id"], "name": favorite.get("name") or "Favoris", "weight": 3})
    if not discovered and len(sources) == 1:
        raise music.MusicError("Aucun titre Spotify vérifié pour cette activité.", 409, "not_enough_discoveries")
    session = music.generate_session_from_body({"sources": sources, "config": {
        "length": target, "familiarity": 0.55 if energetic else 0.35,
        "artist_window": 2 if energetic else 4, "max_artist_frequency": 4 if energetic else 2,
    }})
    reasons = {row["uri"]: row["why"] for row in discovered}
    session["tracks"] = [{**row, "why": reasons.get(row.get("uri"), row.get("reason"))}
                         for row in session["tracks"]]
    session["target_minutes"] = minutes
    session["estimated_minutes"] = round(sum(row.get("duration_ms") or 210000 for row in session["tracks"]) / 60000)
    music.store_last_session(session)
    if play:
        try:
            spotify.player_action("play", {"uris": [row["uri"] for row in session["tracks"] if row.get("uri")],
                                           "auto_device": True})
        except spotify.SpotifyError as exc:
            return {"ok": True, **session, "playing": False, "playback_code": exc.code}
    return {"ok": True, **session, "playing": play}
