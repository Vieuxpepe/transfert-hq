"""Transfert HQ — the assistant (Gemini / Gemma). Stdlib only.

Two jobs:
  « Demander »  a question about your own things. HQ gathers what is relevant (calendar, projects and tasks, Inventaire,
                Carnet pages, file names) from the local stores, sends that short context with the question, and returns the
                answer with numbered sources that link back into HQ.
  « Noter »     one sentence becomes up to three proposed actions (event, task, project « Où j'en suis » note, stock
                change or new item, Carnet note). Nothing is written until you confirm; then each action goes through the
                same validation as the page it belongs to (hq_calendar.save_event, hq_projects.apply, hq_inventory.apply,
                hq_carnet.mutate).

The API key lives only in bridge_config.json (``gemini_api_key``) on this PC and is sent only to Google in a header,
never to the browser. Models are tried in order and skipped when they are busy (429/503) or when HQ's own count says the
day's free quota is used (``.hq-ai/usage.json``, per model, per local day, plus a per-minute window). Admin only.
"""

from __future__ import annotations

import json
import os
import re
import threading
import time
import unicodedata
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable

API = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
# (model id, label, requests per minute, requests per day) — the free tier of this key
MODELS = {
    "gemini-3.1-flash-lite": ("Gemini 3.1 Flash Lite", 15, 500),
    "gemini-3.5-flash-lite": ("Gemini 3.5 Flash Lite", 15, 500),
    "gemini-3.6-flash": ("Gemini 3.6 Flash", 5, 20),
    "gemma-4-26b-a4b-it": ("Gemma 4 26B", 30, 14400),
    "gemma-4-31b-it": ("Gemma 4 31B", 30, 14400),
}
ASK_CHAIN = ("gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it")
DEEP_CHAIN = ("gemini-3.6-flash", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite")
CAPTURE_CHAIN = ("gemma-4-26b-a4b-it", "gemini-3.1-flash-lite", "gemini-3.5-flash-lite", "gemma-4-31b-it")
STORE = ".hq-ai"
USAGE = "usage.json"
Q_MAX = 2000
HISTORY_MAX = 6
CONTEXT_CHARS = 24000
TIMEOUT = 45
KINDS = ("event", "task", "project_note", "stock", "note")
STOP = set("""le la les un une des du de d l au aux et ou en dans sur sous pour par avec sans ce cet cette ces mon ma mes ton ta tes
son sa ses notre nos votre vos leur leurs je tu il elle on nous vous ils elles me te se y a est sont ai as avons avez ont suis es
etre être fait faire quoi que qui quand comment combien quel quelle quels quelles est-ce ne pas plus moins tout tous toute toutes
bien très tres alors donc mais car si oui non the of and to in is it what where when how my me""".split())

_cb: dict[str, Any] = {}
_lock = threading.Lock()
_minute: dict[str, list[float]] = {}


class AiError(ValueError):
    def __init__(self, msg: str, status: int = 400, code: str = "validation_error"):
        super().__init__(msg)
        self.status = status
        self.code = code


def bind(**kwargs: Any) -> None:
    """``root``; ``key() -> str``; ``calendar(start, end) -> list[item]``; ``projects() -> {projects, tasks}``;
    ``inventory() -> {places, items}``; ``carnet() -> {pages:[{id, title, text, block, updated}]}``; ``files(words) -> [rel]``;
    writers ``save_event(payload)``, ``projects_apply(data)``, ``inventory_apply(data)``, ``carnet_note(lines) -> page``;
    optional ``post(url, body, headers, timeout) -> (status, dict)`` and ``now``."""
    _cb.update(kwargs)


def _now() -> float:
    fn = _cb.get("now")
    return float(fn()) if callable(fn) else time.time()


# ---------------------------------------------------------------- text helpers (pure)

def fold(s: Any) -> str:
    return unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()


def words(q: str) -> list[str]:
    out = []
    for w in re.findall(r"[a-z0-9]+", fold(q)):
        if len(w) >= 3 and w not in STOP and w not in out:
            out.append(w)
    return out[:12]


def score(text: str, ws: list[str]) -> int:
    t = fold(text)
    return sum(t.count(w) for w in ws)


def excerpt(text: str, ws: list[str], size: int = 700) -> str:
    t = str(text or "")
    if len(t) <= size:
        return t
    f = fold(t)
    pos = min([f.find(w) for w in ws if f.find(w) >= 0] or [0])
    start = max(0, pos - size // 3)
    return ("…" if start else "") + t[start:start + size] + "…"


def extract_json(text: str) -> Any:
    """The model's JSON, even wrapped in prose or a ``` fence."""
    t = str(text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", t, re.S)
    if fence:
        t = fence.group(1).strip()
    try:
        return json.loads(t)
    except ValueError:
        pass
    for open_c, close_c in (("{", "}"), ("[", "]")):
        a, b = t.find(open_c), t.rfind(close_c)
        if a >= 0 and b > a:
            try:
                return json.loads(t[a:b + 1])
            except ValueError:
                continue
    raise AiError("Réponse illisible du modèle", 502, "bad_model_output")


# ---------------------------------------------------------------- quota

def _usage_path() -> Path:
    return Path(_cb["root"]) / STORE / USAGE


def _today() -> str:
    return datetime.fromtimestamp(_now()).strftime("%Y-%m-%d")


def usage() -> dict:
    p = _usage_path()
    try:
        data = json.loads(p.read_text("utf-8"))
        if isinstance(data, dict) and data.get("day") == _today() and isinstance(data.get("count"), dict):
            return data
    except (OSError, ValueError):
        pass
    return {"day": _today(), "count": {}}


def _count(model: str) -> None:
    with _lock:
        u = usage()
        u["count"][model] = int(u["count"].get(model, 0)) + 1
        p = _usage_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(u), "utf-8")
        os.replace(tmp, p)
        _minute.setdefault(model, []).append(_now())


def available(model: str) -> bool:
    label, rpm, rpd = MODELS[model]
    if int(usage()["count"].get(model, 0)) >= rpd:
        return False
    now = _now()
    recent = [t for t in _minute.get(model, []) if now - t < 60]
    _minute[model] = recent
    return len(recent) < rpm


# ---------------------------------------------------------------- calling Gemini

def _post(url: str, body: dict, headers: dict, timeout: int) -> tuple[int, dict]:
    fn = _cb.get("post")
    if callable(fn):
        return fn(url, body, headers, timeout)
    req = urllib.request.Request(url, data=json.dumps(body).encode("utf-8"), headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8") or "{}")
        except ValueError:
            return e.code, {}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise AiError("Google injoignable (" + str(getattr(e, "reason", e))[:80] + ")", 502, "unreachable") from e


def generate(chain: tuple[str, ...], system: str, contents: list[dict], *, json_out: bool = False, temperature: float = 0.3) -> tuple[str, str]:
    """(text, model). Tries each model of ``chain`` in turn; busy or exhausted models are skipped."""
    key = _cb["key"]() if callable(_cb.get("key")) else ""
    if not key:
        raise AiError("Aucune clé : ajoute gemini_api_key dans bridge_config.json puis redémarre le pont", 503, "no_key")
    body: dict[str, Any] = {"systemInstruction": {"parts": [{"text": system}]}, "contents": contents,
                            "generationConfig": {"temperature": temperature, "maxOutputTokens": 2048}}
    if json_out:
        body["generationConfig"]["responseMimeType"] = "application/json"
    last = "Tous les modèles sont occupés ou à court de quota pour aujourd'hui"
    for model in chain:
        if not available(model):
            continue
        _count(model)
        status, data = _post(API.format(model=model), body, {"Content-Type": "application/json", "x-goog-api-key": key}, TIMEOUT)
        if status in (429, 500, 503, 504):
            last = (data.get("error") or {}).get("message") or f"{model} occupé ({status})"
            continue
        if status != 200:
            msg = (data.get("error") or {}).get("message") or f"Erreur {status}"
            raise AiError(msg[:300], 502 if status >= 500 else 400, "model_error")
        cands = data.get("candidates") or []
        parts = ((cands[0].get("content") or {}).get("parts") or []) if cands else []
        text = "".join(p.get("text", "") for p in parts if isinstance(p, dict) and not p.get("thought"))
        if not text.strip():
            last = f"{model} n'a rien répondu"
            continue
        return text.strip(), model
    raise AiError(str(last)[:300], 503, "busy")


# ---------------------------------------------------------------- what HQ knows (context)

def _place_paths(places: list[dict]) -> dict[str, str]:
    by = {p["id"]: p for p in places if isinstance(p, dict) and p.get("id")}
    out = {}
    for pid in by:
        names, cur, guard = [], by.get(pid), 0
        while cur and guard < 12:
            names.append(cur.get("name") or cur.get("code") or "?")
            cur, guard = by.get(cur.get("parent")), guard + 1
        out[pid] = " › ".join(reversed(names))
    return out


def _fmt_item_when(it: dict) -> str:
    s, e = str(it.get("start") or ""), str(it.get("end") or "")
    if it.get("all_day"):
        return s[:10] + " (journée)"
    return s.replace("T", " ") + ("–" + e[11:16] if e[:10] == s[:10] and len(e) >= 16 else ("→" + e.replace("T", " ") if e else ""))


def gather(q: str) -> tuple[str, list[dict]]:
    """A compact context for the question, and the sources it may cite."""
    ws = words(q)
    sources: list[dict] = []
    blocks: list[str] = []

    def src(kind: str, label: str, href: str, rel: str | None = None) -> int:
        sources.append({"n": len(sources) + 1, "kind": kind, "label": label[:120], "href": href, **({"rel": rel} if rel else {})})
        return len(sources)

    now = datetime.fromtimestamp(_now())
    try:
        items = _cb["calendar"](now - timedelta(days=1), now + timedelta(days=21)) or []
    except Exception:
        items = []
    if items:
        n = src("calendar", "Calendrier (3 semaines)", "#calendrier")
        lines = [f"- {_fmt_item_when(i)} · {i.get('title', '')}" + (f" [{i.get('category')}]" if i.get("category") else "") + (" (fait)" if i.get("done") else "")
                 for i in items[:60] if isinstance(i, dict)]
        blocks.append(f"[{n}] CALENDRIER (d'hier à dans 3 semaines)\n" + "\n".join(lines))
    try:
        pj = _cb["projects"]() or {}
    except Exception:
        pj = {}
    projects = [p for p in (pj.get("projects") or []) if isinstance(p, dict)]
    tasks = [t for t in (pj.get("tasks") or []) if isinstance(t, dict)]
    for p in sorted(projects, key=lambda p: (p.get("status") != "active", -score(p.get("name", "") + " " + p.get("goal", ""), ws))):
        if p.get("status") in ("done", "archived") and not score(p.get("name", ""), ws):
            continue
        n = src("project", "Projet · " + (p.get("name") or "?"), "#projets/" + p["id"])
        ms = [m for m in (p.get("milestones") or []) if isinstance(m, dict) and not m.get("done")]
        open_t = [t for t in tasks if t.get("project") == p.get("id") and t.get("column") != "done"]
        missing = [b for b in (p.get("bom") or []) if isinstance(b, dict) and b.get("status") != "have"]
        blocks.append(f"[{n}] PROJET « {p.get('name')} » ({p.get('status')}" + (f", échéance {p.get('due')}" if p.get("due") else "") + ")"
                      + (f"\n  But : {p.get('goal')}" if p.get("goal") else "")
                      + (f"\n  Où j'en suis : {p.get('resume')}" if p.get("resume") else "")
                      + ("\n  Jalons ouverts : " + "; ".join(f"{m.get('title')}" + (f" ({m.get('due')})" if m.get("due") else "") for m in ms[:6]) if ms else "")
                      + ("\n  Tâches ouvertes : " + "; ".join(f"{t.get('title')} [{t.get('column')}]" + (f" ({t.get('due')})" if t.get("due") else "") for t in open_t[:8]) if open_t else "")
                      + ("\n  Pièces à obtenir : " + "; ".join(f"{b.get('name') or b.get('label') or '?'} ×{b.get('qty', 1)} ({b.get('status')})" for b in missing[:8]) if missing else ""))
        if len(sources) > 14:
            break
    free = [t for t in tasks if not t.get("project") and t.get("column") != "done"]
    if free:
        n = src("project", "Tâches libres", "#projets/libres")
        blocks.append(f"[{n}] TÂCHES LIBRES\n" + "\n".join(f"- {t.get('title')} [{t.get('column')}]" + (f" ({t.get('due')})" if t.get("due") else "") for t in free[:15]))
    try:
        inv = _cb["inventory"]() or {}
    except Exception:
        inv = {}
    paths = _place_paths(inv.get("places") or [])
    inv_items = [i for i in (inv.get("items") or []) if isinstance(i, dict)]
    scored = sorted(inv_items, key=lambda i: -score(f"{i.get('name')} {' '.join(i.get('tags') or [])} {i.get('note', '')} {paths.get(i.get('place'), '')}", ws))
    pick = [i for i in scored if score(f"{i.get('name')} {' '.join(i.get('tags') or [])} {i.get('note', '')} {paths.get(i.get('place'), '')}", ws)][:20]
    if not pick and len(inv_items) <= 40:
        pick = inv_items
    low = [i for i in inv_items if isinstance(i.get("min"), (int, float)) and i.get("qty", 0) < i["min"] and i not in pick][:10]
    for i in pick + low:
        n = src("item", "Objet · " + (i.get("name") or "?"), "#inventaire/objet/" + i["id"])
        blocks.append(f"[{n}] OBJET « {i.get('name')} » : {i.get('qty')} {i.get('unit') or ''}".rstrip()
                      + f" · rangé : {paths.get(i.get('place')) or 'sans emplacement'}"
                      + (f" · seuil {i.get('min')}" if i.get("min") is not None else "") + (f" · {i.get('note')}" if i.get("note") else ""))
    try:
        pages = (_cb["carnet"]() or {}).get("pages") or []
    except Exception:
        pages = []
    ranked = sorted(pages, key=lambda p: -(3 * score(p.get("title", ""), ws) + score(p.get("text", ""), ws)))
    chosen = [p for p in ranked if ws and (3 * score(p.get("title", ""), ws) + score(p.get("text", ""), ws))][:5] or sorted(pages, key=lambda p: -(p.get("updated") or 0))[:2]
    for p in chosen:
        href = "#carnet/" + p["id"] + ("/" + p["block"] if p.get("block") else "")
        n = src("carnet", "Carnet · " + (p.get("title") or "Sans titre"), href)
        blocks.append(f"[{n}] PAGE DU CARNET « {p.get('title') or 'Sans titre'} »\n{excerpt(p.get('text', ''), ws)}")
    if ws:
        try:
            rels = _cb["files"](ws) or []
        except Exception:
            rels = []
        if rels:
            n = src("files", "Fichiers trouvés", "#fichiers")
            for rel in rels[:15]:
                src("file", rel.split("/")[-1], "#fichiers", rel)
            blocks.append(f"[{n}] FICHIERS DONT LE NOM CORRESPOND\n" + "\n".join("- " + r for r in rels[:15]))
    text = "\n\n".join(blocks)
    return text[:CONTEXT_CHARS], sources


# ---------------------------------------------------------------- « Demander »

ASK_SYSTEM = """Tu es l'assistant de Transfert HQ, le tableau de bord personnel de l'utilisateur (étudiant en génie, francophone, Québec).
Réponds en français, brièvement et concrètement (quelques phrases ou une courte liste « - »). Pas de titres, pas de tableaux.
Utilise seulement le CONTEXTE fourni et la conversation ; si l'information n'y est pas, dis-le simplement et propose où regarder dans HQ.
Cite tes sources avec leurs numéros entre crochets, comme [2], juste après l'information.
Aujourd'hui : {today}."""

DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"]


def _today_text() -> str:
    d = datetime.fromtimestamp(_now())
    return f"{DAYS[d.weekday()]} {d.strftime('%Y-%m-%d %H:%M')}"


def ask(q: Any, history: Any = None, deep: bool = False) -> dict:
    if not isinstance(q, str) or not q.strip():
        raise AiError("Question vide")
    q = q.strip()[:Q_MAX]
    context, sources = gather(q + " " + " ".join(str(h.get("text", "")) for h in (history or [])[-2:] if isinstance(h, dict) and h.get("role") == "user"))
    contents = []
    for h in (history or [])[-HISTORY_MAX:]:
        if isinstance(h, dict) and h.get("role") in ("user", "model") and isinstance(h.get("text"), str):
            contents.append({"role": h["role"], "parts": [{"text": h["text"][:Q_MAX]}]})
    contents.append({"role": "user", "parts": [{"text": f"CONTEXTE\n{context or '(rien de pertinent trouvé)'}\n\nQUESTION\n{q}"}]})
    text, model = generate(DEEP_CHAIN if deep else ASK_CHAIN, ASK_SYSTEM.format(today=_today_text()), contents)
    cited = sorted({int(n) for n in re.findall(r"\[(\d{1,2})\]", text) if 0 < int(n) <= len(sources)})
    return {"ok": True, "answer": text[:6000], "model": model, "model_label": MODELS[model][0], "sources": sources, "cited": cited}


# ---------------------------------------------------------------- « Noter »

CAPTURE_SYSTEM = """Tu transformes UNE phrase de l'utilisateur en actions pour son tableau de bord. Aujourd'hui : {today} (fuseau local).
Réponds UNIQUEMENT en JSON : {{"actions": [ ... ], "reply": "une courte phrase en français"}} avec au plus 3 actions parmi :
- {{"kind":"event","title":"…","start":"AAAA-MM-JJTHH:MM","end":"AAAA-MM-JJTHH:MM","all_day":false,"category":"personal|study|appointment|maintenance|hq|other"}}
  (journée entière : "all_day":true, start et end en AAAA-MM-JJ, end = lendemain ; sans heure de fin, 1 h)
- {{"kind":"task","title":"…","project":"id du projet ou null","due":"AAAA-MM-JJ ou null"}}
- {{"kind":"project_note","project":"id du projet","text":"la note « Où j'en suis »","mode":"replace|append"}}
- {{"kind":"stock","item":"id de l'objet existant ou null","name":"nom si nouvel objet","delta":entier (+ ajouté, - utilisé),"unit":"","place":"id d'emplacement ou null"}}
  (objet existant : delta seulement ; nouvel objet : delta = quantité de départ)
- {{"kind":"note","text":"texte de la note pour le Carnet"}}
Utilise UNIQUEMENT les ids des listes ci-dessous. Si rien ne correspond à une action, renvoie "actions": [] et explique dans reply.
PROJETS : {projects}
OBJETS : {items}
EMPLACEMENTS : {places}"""


def _capture_lists(text: str) -> tuple[str, str, str, dict]:
    ws = words(text)
    pj = _cb["projects"]() or {}
    projects = [p for p in (pj.get("projects") or []) if isinstance(p, dict) and p.get("status") not in ("archived",)]
    inv = _cb["inventory"]() or {}
    places = [p for p in (inv.get("places") or []) if isinstance(p, dict)]
    paths = _place_paths(places)
    items = [i for i in (inv.get("items") or []) if isinstance(i, dict)]
    if len(items) > 80:
        items = sorted(items, key=lambda i: -score(f"{i.get('name')} {' '.join(i.get('tags') or [])}", ws))[:80]
    if len(places) > 80:
        places = sorted(places, key=lambda p: -score(paths.get(p["id"], ""), ws))[:80]
    lp = "; ".join(f"{p['id']}={p.get('name')}" for p in projects[:40]) or "(aucun)"
    li = "; ".join(f"{i['id']}={i.get('name')} ({i.get('qty')} {i.get('unit') or ''}, {paths.get(i.get('place')) or 'sans emplacement'})" for i in items) or "(aucun)"
    lpl = "; ".join(f"{p['id']}={paths.get(p['id'])}" + (f" [{p.get('code')}]" if p.get("code") else "") for p in places) or "(aucun)"
    world = {"projects": {p["id"]: p for p in pj.get("projects") or [] if isinstance(p, dict)},
             "items": {i["id"]: i for i in inv.get("items") or [] if isinstance(i, dict)},
             "places": {p["id"]: p for p in inv.get("places") or [] if isinstance(p, dict)}, "paths": paths}
    return lp, li, lpl, world


_MIN = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$")
_DAY = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def normalize(action: Any, world: dict) -> dict:
    """A proposal checked against what exists, with a French label for the confirmation card. Raises AiError."""
    if not isinstance(action, dict) or action.get("kind") not in KINDS:
        raise AiError("Action inconnue")
    k = action["kind"]
    s = lambda v, n=200: (str(v).strip()[:n] if isinstance(v, (str, int, float)) and str(v).strip() else "")  # noqa: E731
    if k == "event":
        title = s(action.get("title"), 140)
        all_day = action.get("all_day") is True
        start, end = s(action.get("start"), 16), s(action.get("end"), 16)
        if not title:
            raise AiError("Événement sans titre")
        if all_day:
            start, end = start[:10], end[:10]
            if not _DAY.match(start):
                raise AiError("Date invalide")
            if not _DAY.match(end) or end <= start:
                end = (datetime.strptime(start, "%Y-%m-%d") + timedelta(days=1)).strftime("%Y-%m-%d")
        else:
            if not _MIN.match(start):
                raise AiError("Heure invalide")
            if not _MIN.match(end) or end <= start:
                end = (datetime.strptime(start, "%Y-%m-%dT%H:%M") + timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M")
        cat = action.get("category") if action.get("category") in ("personal", "study", "appointment", "maintenance", "hq", "other") else "other"
        when = start if all_day else start.replace("T", " ") + "–" + end[11:]
        return {"kind": k, "title": title, "start": start, "end": end, "all_day": all_day, "category": cat, "label": f"Événement · {title} · {when}"}
    if k == "task":
        title = s(action.get("title"), 140)
        if not title:
            raise AiError("Tâche sans titre")
        pid = action.get("project") if action.get("project") in world["projects"] else None
        due = s(action.get("due"), 10) if _DAY.match(s(action.get("due"), 10)) else None
        pname = world["projects"][pid]["name"] if pid else "Tâches libres"
        return {"kind": k, "title": title, "project": pid, "due": due, "label": f"Tâche · {title} · {pname}" + (f" · pour le {due}" if due else "")}
    if k == "project_note":
        pid = action.get("project")
        if pid not in world["projects"]:
            raise AiError("Projet introuvable")
        text = s(action.get("text"), 1000)
        if not text:
            raise AiError("Note vide")
        mode = "append" if action.get("mode") == "append" else "replace"
        return {"kind": k, "project": pid, "text": text, "mode": mode,
                "label": f"Où j'en suis · {world['projects'][pid]['name']} · {'ajout' if mode == 'append' else 'nouvelle note'} : {text}"}
    if k == "stock":
        delta = action.get("delta")
        if isinstance(delta, float) and delta.is_integer():
            delta = int(delta)
        if isinstance(delta, bool) or not isinstance(delta, int) or delta == 0 or abs(delta) > 1_000_000:
            raise AiError("Quantité invalide")
        iid = action.get("item")
        if iid in world["items"]:
            it = world["items"][iid]
            return {"kind": k, "item": iid, "delta": delta,
                    "label": f"Stock · {it.get('name')} {'+' if delta > 0 else '−'}{abs(delta)} (→ {max(0, int(it.get('qty') or 0) + delta)})"}
        name = s(action.get("name"), 80)
        if not name or delta < 0:
            raise AiError("Objet introuvable")
        place = action.get("place") if action.get("place") in world["places"] else None
        unit = s(action.get("unit"), 20)
        return {"kind": k, "item": None, "name": name, "delta": delta, "unit": unit, "place": place,
                "label": f"Nouvel objet · {name} × {delta}{(' ' + unit) if unit else ''} · {world['paths'].get(place) if place else 'sans emplacement'}"}
    text = s(action.get("text"), 4000)
    if not text:
        raise AiError("Note vide")
    return {"kind": "note", "text": text, "label": "Note du Carnet · " + text[:120] + ("…" if len(text) > 120 else "")}


def capture(text: Any) -> dict:
    if not isinstance(text, str) or not text.strip():
        raise AiError("Phrase vide")
    text = text.strip()[:Q_MAX]
    lp, li, lpl, world = _capture_lists(text)
    system = CAPTURE_SYSTEM.format(today=_today_text(), projects=lp, items=li, places=lpl)
    out, model = generate(CAPTURE_CHAIN, system, [{"role": "user", "parts": [{"text": text}]}], json_out=True, temperature=0.1)
    data = extract_json(out)
    raw = data.get("actions") if isinstance(data, dict) else data if isinstance(data, list) else []
    proposals, refused = [], []
    for a in (raw or [])[:3]:
        try:
            proposals.append(normalize(a, world))
        except AiError as e:
            refused.append(str(e))
    reply = str(data.get("reply") or "")[:300] if isinstance(data, dict) else ""
    return {"ok": True, "proposals": proposals, "refused": refused, "reply": reply, "model": model, "model_label": MODELS[model][0]}


def apply_one(p: dict, world: dict) -> dict:
    """Write one confirmed proposal through its own module. Returns {kind, label, href}."""
    p = normalize(p, world)  # re-checked: the list may have changed since the proposal
    k = p["kind"]
    if k == "event":
        _cb["save_event"]({"title": p["title"], "start": p["start"], "end": p["end"], "all_day": p["all_day"], "category": p["category"]})
        return {"kind": k, "label": p["label"], "href": "#calendrier"}
    if k == "task":
        _cb["projects_apply"]({"action": "task.create", "title": p["title"], **({"project": p["project"]} if p["project"] else {}), **({"due": p["due"]} if p["due"] else {})})
        return {"kind": k, "label": p["label"], "href": "#projets/" + (p["project"] or "libres")}
    if k == "project_note":
        cur = world["projects"][p["project"]].get("resume") or ""
        text = (cur + "\n" + p["text"]).strip()[-1000:] if p["mode"] == "append" and cur else p["text"]
        _cb["projects_apply"]({"action": "project.resume", "id": p["project"], "text": text})
        return {"kind": k, "label": p["label"], "href": "#projets/" + p["project"]}
    if k == "stock":
        if p["item"]:
            _cb["inventory_apply"]({"action": "item.adjust", "id": p["item"], "delta": p["delta"]})
            return {"kind": k, "label": p["label"], "href": "#inventaire/objet/" + p["item"]}
        out = _cb["inventory_apply"]({"action": "item.create", "name": p["name"], "qty": p["delta"], "unit": p["unit"], "place": p["place"]})
        iid = ((out or {}).get("item") or {}).get("id")
        return {"kind": k, "label": p["label"], "href": "#inventaire/objet/" + iid if iid else "#inventaire"}
    page = _cb["carnet_note"]([ln for ln in p["text"].split("\n")][:200]) or {}
    return {"kind": k, "label": p["label"], "href": "#carnet/" + page["id"] + "/" + page["block"] if page.get("id") and page.get("block") else "#carnet"}


def apply(proposals: Any) -> dict:
    if not isinstance(proposals, list) or not proposals or len(proposals) > 3:
        raise AiError("Rien à enregistrer")
    _, _, _, world = _capture_lists("")
    done, failed = [], []
    for p in proposals:
        try:
            done.append(apply_one(p, world))
        except Exception as e:  # each module raises its own error type; the message is already French
            failed.append({"label": (p.get("label") if isinstance(p, dict) else "") or "Action", "error": str(e)[:200]})
    return {"ok": bool(done), "done": done, "failed": failed}


# ---------------------------------------------------------------- HTTP

def status() -> dict:
    key = _cb["key"]() if callable(_cb.get("key")) else ""
    u = usage()
    return {"ok": True, "configured": bool(key),
            "models": [{"id": m, "label": v[0], "per_day": v[2], "used": int(u["count"].get(m, 0))} for m, v in MODELS.items()]}


def http_get(_qs: dict) -> tuple[int, dict]:
    return 200, status()


def http_post(data: Any) -> tuple[int, dict]:
    try:
        if not isinstance(data, dict):
            raise AiError("Requête invalide")
        a = data.get("action")
        if a == "ask":
            hist = data.get("history") if isinstance(data.get("history"), list) else []
            return 200, ask(data.get("q"), hist, deep=data.get("deep") is True)
        if a == "capture":
            return 200, capture(data.get("text"))
        if a == "apply":
            out = apply(data.get("proposals"))
            return (200 if out["ok"] else 400), out
        raise AiError("Action inconnue")
    except AiError as e:
        return e.status, {"error": str(e), "code": e.code}
