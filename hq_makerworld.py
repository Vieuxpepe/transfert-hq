"""MakerWorld statistics for the Master's own account — read only.

Two sources, both on makerworld.com only:

* ``/api/v1/design-service/published/<uid>/design?handle=<h>&limit=&offset=``
  — every published design with its downloads / prints / likes / collections.
  This JSON endpoint is not behind the Cloudflare challenge.
* ``/en/@<handle>`` — the profile page; its ``__NEXT_DATA__`` JSON carries the
  followers, boosts, points and the uid. Cloudflare challenges plain clients
  here, so it is sent with the Master's pasted session cookie (``cf_clearance``
  is bound to the browser's User-Agent, so the UA can be pasted too). When it is
  challenged we keep the design totals and say ``makerworld_blocked``.

The cookie never leaves ``.hq-agent-state/print3d.json``: it is not logged, not
returned by an API and not sent anywhere but makerworld.com.
"""
from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Callable

HOST = "makerworld.com"
BASE = "https://" + HOST
TIMEOUT = 20
MAX_BODY = 4 * 1024 * 1024
PAGE_LIMIT = 50
MAX_PAGES = 20
DEFAULT_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36")
HANDLE_RE = re.compile(r"^[A-Za-z0-9_.-]{2,40}$")
_NEXT_RE = re.compile(rb'<script id="__NEXT_DATA__" type="application/json"[^>]*>(.*?)</script>', re.S)


class MakerWorldError(Exception):
    def __init__(self, message: str, code: str = "makerworld_error") -> None:
        super().__init__(message)
        self.code = code


Opener = Callable[[urllib.request.Request, float], Any]


class _SameHostRedirect(urllib.request.HTTPRedirectHandler):
    """urllib re-sends every header, Cookie included, to a redirect target: refuse any that
    leaves https://makerworld.com so the session cookie can never travel elsewhere."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: ANN001
        parts = urllib.parse.urlsplit(newurl)
        if parts.scheme != "https" or parts.hostname != HOST:
            return None
        return super().redirect_request(req, fp, code, msg, headers, newurl)


_OPENER = urllib.request.build_opener(_SameHostRedirect)


def _default_open(req: urllib.request.Request, timeout: float) -> Any:
    return _OPENER.open(req, timeout=timeout)


def _get(url: str, *, cookie: str, ua: str, accept: str, opener: Opener) -> bytes:
    parts = urllib.parse.urlsplit(url)
    if parts.scheme != "https" or parts.hostname != HOST:
        raise MakerWorldError("Hôte refusé", "makerworld_error")
    headers = {"User-Agent": ua or DEFAULT_UA, "Accept": accept,
               "Accept-Language": "en-US,en;q=0.9"}
    if cookie:
        headers["Cookie"] = cookie
    req = urllib.request.Request(url, headers=headers, method="GET")
    try:
        resp = opener(req, TIMEOUT)
        body = resp.read(MAX_BODY + 1)
    except urllib.error.HTTPError as exc:
        mitigated = (exc.headers.get("cf-mitigated") if exc.headers else "") or ""
        if exc.code in (403, 429, 503) or mitigated:
            raise MakerWorldError("MakerWorld bloque la requête (Cloudflare)", "makerworld_blocked") from None
        if exc.code == 401:
            raise MakerWorldError("Cookie MakerWorld expiré", "makerworld_blocked") from None
        raise MakerWorldError(f"MakerWorld a répondu {exc.code}") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise MakerWorldError("MakerWorld injoignable", "makerworld_unreachable") from None
    if len(body) > MAX_BODY:
        raise MakerWorldError("Réponse MakerWorld trop grande")
    if b"challenge-platform" in body[:20000] or b"Just a moment" in body[:4000]:
        raise MakerWorldError("MakerWorld bloque la requête (Cloudflare)", "makerworld_blocked")
    return body


def _int(value: Any) -> int:
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def parse_profile(html: bytes) -> dict[str, Any]:
    m = _NEXT_RE.search(html)
    if not m:
        raise MakerWorldError("Profil MakerWorld illisible", "makerworld_parse")
    try:
        props = json.loads(m.group(1).decode("utf-8", "replace"))["props"]["pageProps"]
        info = props["userInfo"]
    except (ValueError, KeyError, TypeError):
        raise MakerWorldError("Profil MakerWorld illisible", "makerworld_parse") from None
    mw = info.get("MWCount") if isinstance(info.get("MWCount"), dict) else {}
    level = (info.get("personal") or {}).get("userLevel") or {}
    return {
        "uid": _int(info.get("uid")),
        "name": str(info.get("name") or "")[:80],
        "handle": str(info.get("handle") or "")[:40],
        "followers": _int(info.get("fanCount")),
        "following": _int(info.get("followCount")),
        "likes": _int(info.get("likeCount")),
        "collections": _int(info.get("collectionCount")),
        "downloads_total": _int(info.get("downloadCount")),
        "design_downloads": _int(mw.get("myDesignDownloadCount")),
        "design_prints": _int(mw.get("myDesignPrintCount")),
        "design_count": _int(mw.get("designCount")),
        "boosts_gained": _int(info.get("boostGained")),
        "boosts_available": _int(info.get("boost")),
        "points": _int(info.get("point")),
        "level": _int(level.get("level")) if isinstance(level, dict) else 0,
        "self": bool(props.get("selfFlag")),
    }


def parse_designs(raw: bytes) -> tuple[int, list[dict[str, Any]]]:
    try:
        data = json.loads(raw.decode("utf-8", "replace"))
    except ValueError:
        raise MakerWorldError("Liste MakerWorld illisible", "makerworld_parse") from None
    if not isinstance(data, dict) or not isinstance(data.get("hits"), list):
        raise MakerWorldError("Liste MakerWorld illisible", "makerworld_parse")
    rows = []
    for hit in data["hits"]:
        if not isinstance(hit, dict) or not _int(hit.get("id")):
            continue
        cover = str(hit.get("coverUrl") or "")
        rows.append({
            "id": _int(hit.get("id")),
            "title": str(hit.get("title") or "")[:160],
            "slug": str(hit.get("slug") or "")[:160],
            "cover": cover if cover.startswith("https://makerworld.bblmw.com/") else "",
            "downloads": _int(hit.get("downloadCount")),
            "prints": _int(hit.get("printCount")),
            "likes": _int(hit.get("likeCount")),
            "collections": _int(hit.get("collectionCount")),
            "comments": _int(hit.get("commentCount")),
            "published": str(hit.get("publishTime") or hit.get("createTime") or "")[:25],
        })
    return _int(data.get("total")), rows


def fetch(handle: str, *, uid: int = 0, cookie: str = "", ua: str = "",
          opener: Opener = _default_open) -> dict[str, Any]:
    """One snapshot. Raises MakerWorldError only when neither source answered."""
    if not HANDLE_RE.fullmatch(handle or ""):
        raise MakerWorldError("Pseudo MakerWorld requis", "makerworld_not_configured")
    profile: dict[str, Any] | None = None
    profile_error = ""
    try:
        profile = parse_profile(_get(f"{BASE}/en/@{urllib.parse.quote(handle)}", cookie=cookie, ua=ua,
                                     accept="text/html,application/xhtml+xml", opener=opener))
        uid = profile["uid"] or uid
    except MakerWorldError as exc:
        profile_error = exc.code
    if not uid:
        raise MakerWorldError("MakerWorld bloque le profil ; indique ton uid dans les réglages",
                              profile_error or "makerworld_blocked")
    designs: list[dict[str, Any]] = []
    total = 0
    for page in range(MAX_PAGES):
        q = urllib.parse.urlencode({"handle": handle, "limit": PAGE_LIMIT, "offset": page * PAGE_LIMIT})
        total, rows = parse_designs(_get(f"{BASE}/api/v1/design-service/published/{int(uid)}/design?{q}",
                                         cookie=cookie, ua=ua, accept="application/json", opener=opener))
        designs.extend(rows)
        if not rows or len(designs) >= total:
            break
    sums = {k: sum(d[k] for d in designs) for k in ("downloads", "prints", "likes", "collections", "comments")}
    return {
        "at": int(time.time()),
        "uid": int(uid),
        "handle": handle,
        "profile": profile,
        "profile_error": profile_error,
        "design_total": total or len(designs),
        "totals": sums,
        "designs": designs,
    }


def history_point(snapshot: dict[str, Any]) -> dict[str, Any]:
    """The compact row kept for charts."""
    p = snapshot.get("profile") or {}
    t = snapshot.get("totals") or {}
    return {"at": snapshot.get("at"), "downloads": t.get("downloads", 0), "prints": t.get("prints", 0),
            "likes": t.get("likes", 0), "collections": t.get("collections", 0),
            "followers": p.get("followers"), "boosts": p.get("boosts_gained"), "points": p.get("points"),
            "designs": {str(d["id"]): [d["downloads"], d["prints"], d["likes"], d.get("comments", 0)]
                        for d in snapshot.get("designs") or []}}


# ── alerts: spikes and new comments ────────────────────────────────────────

ALERT_DEFAULTS = {"enabled": True, "push": False, "min_jump": 10, "ratio_pct": 50}
SPIKE_WINDOW = (12 * 3600, 48 * 3600)       # the comparison snapshot must be 12-48 h old, nearest to a day
MAX_ALERTS = 40


def clean_alert_settings(data: Any, current: Any = None) -> dict[str, Any]:
    out = dict(ALERT_DEFAULTS)
    for src in (current, data):
        if not isinstance(src, dict):
            continue
        for key in ("enabled", "push"):
            if key in src:
                out[key] = src[key] is True
        for key, lo, hi in (("min_jump", 1, 5000), ("ratio_pct", 5, 1000)):
            if key in src:
                try:
                    out[key] = max(lo, min(hi, int(src[key])))
                except (TypeError, ValueError):
                    pass
    return out


def detect_alerts(prev: dict[str, Any] | None, snap: dict[str, Any], history: list[dict[str, Any]],
                  now: int, settings: dict[str, Any]) -> list[dict[str, Any]]:
    """New alerts between the last snapshot (comments) and about a day ago (downloads / prints)."""
    if not settings.get("enabled"):
        return []
    out: list[dict[str, Any]] = []
    old = {d["id"]: d for d in (prev or {}).get("designs") or [] if isinstance(d, dict)}
    for d in snap.get("designs") or []:
        before = old.get(d["id"])
        if before and d.get("comments", 0) > before.get("comments", 0):
            n = d["comments"] - before.get("comments", 0)
            out.append({"id": f"comments:{d['id']}:{d['comments']}", "kind": "comments", "design_id": d["id"],
                        "title": d.get("title", ""), "at": now,
                        "text": f"{n} new comment{'s' if n != 1 else ''} on “{d.get('title', '')[:70]}”"})
    rows = [h for h in history if WINDOW_OK(now - int(h.get("at") or 0))]
    if rows:
        base = min(rows, key=lambda h: abs(now - int(h.get("at") or 0) - 86400))
        hours = max(1, round((now - int(base["at"])) / 3600))
        day = time.strftime("%Y-%m-%d", time.localtime(now))
        for d in snap.get("designs") or []:
            b = (base.get("designs") or {}).get(str(d["id"]))
            if not b:
                continue                                     # published since: nothing to compare with
            gain_dl, gain_pr = d["downloads"] - b[0], d["prints"] - b[1]
            for gain, was, label in ((gain_dl, b[0], "downloads"), (gain_pr, b[1], "prints")):
                if gain >= settings["min_jump"] and gain * 100 >= settings["ratio_pct"] * max(1, was):
                    out.append({"id": f"spike:{d['id']}:{day}", "kind": "spike", "design_id": d["id"],
                                "title": d.get("title", ""), "at": now,
                                "text": f"“{d.get('title', '')[:70]}” gained +{gain_dl} downloads and +{gain_pr} prints "
                                        f"in about {hours} h"})
                    break
    seen: set[str] = set()
    return [a for a in out if not (a["id"] in seen or seen.add(a["id"]))]


def WINDOW_OK(age: int) -> bool:
    return SPIKE_WINDOW[0] <= age <= SPIKE_WINDOW[1]


# ── matching a file to a design ────────────────────────────────────────────

_NOISE = re.compile(r"\b(?:stl|3mf|gcode|step|obj|v\d+|final|fixed|supported|unsupported|print|presupported)\b")


def _norm(text: str) -> str:
    text = re.sub(r"\.[A-Za-z0-9]{2,5}$", "", str(text or "")).lower()
    text = re.sub(r"[_\-.|()\[\],:+]+", " ", text)
    text = _NOISE.sub(" ", text)
    return re.sub(r"[^a-z0-9 ]+", "", text).strip()


def match_designs(name: str, designs: list[dict[str, Any]], limit: int = 3) -> list[dict[str, Any]]:
    """Designs whose title looks like the file name, best first (score 0-100). Suggestions only."""
    import difflib
    want = _norm(name)
    if len(want) < 3:
        return []
    words = set(want.split())
    scored = []
    for d in designs:
        title = _norm(d.get("title", ""))
        if not title:
            continue
        ratio = difflib.SequenceMatcher(None, want, title).ratio()
        tw = set(title.split())
        overlap = len(words & tw) / max(1, min(len(words), len(tw)))
        score = round(100 * max(ratio, 0.6 * ratio + 0.4 * overlap, 0.85 if want in title or title in want else 0))
        if score >= 55:
            scored.append({"id": d["id"], "title": d.get("title", ""), "score": min(score, 100),
                           "downloads": d.get("downloads", 0), "cover": d.get("cover", "")})
    scored.sort(key=lambda r: (-r["score"], -r["downloads"]))
    return scored[:max(1, limit)]
