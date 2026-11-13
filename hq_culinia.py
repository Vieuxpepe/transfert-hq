"""Culinia — HQ Meal Planner & Kitchen Steward AI.

Memory is separate from every other HQ assistant (roster: hq_personas).
Uses hq_ai.generate for replies; tools inspect hq_grocery (products, lots,
merchants, shopping lists) and persist Culinia's weekly meal plan.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
import hashlib
import json
import logging
import os
import re
import threading
import time
import urllib.parse
import urllib.request

import hq_finances
import hq_grocery
import hq_inventory
import hq_meals
import hq_personas
import hq_state

STATE_FOLDER = ".hq-household"
THREAD_FILE = "culinia_thread.json"
MEAL_PLAN_FILE = "culinia_meals.json"
PREFS_FILE = "culinia_prefs.json"
MAX_THREAD = 40
MAX_MESSAGE = 4000
MAX_ROUNDS = 4
MAX_TOTAL_TOOLS = 8
DEFAULT_REPLY_ATTEMPTS = 3
MAX_REPLY_ATTEMPTS = 10
log = logging.getLogger(__name__)
# Process-local since start: tells the status endpoint whether replies are racing.
_contention = {"regenerations": 0, "fallbacks": 0}
_contention_lock = threading.Lock()


def _contention_snapshot() -> dict[str, int]:
    with _contention_lock:
        return dict(_contention)


def _note_contention(regenerations: int, fallback: bool) -> None:
    if not regenerations and not fallback:
        return
    with _contention_lock:
        _contention["regenerations"] += regenerations
        _contention["fallbacks"] += 1 if fallback else 0


def _reply_attempts() -> int:
    """How many append attempts a reply may make when turns land mid-answer.

    Each failed attempt regenerates once, so this also bounds extra model calls.
    """
    raw = os.environ.get("HQ_CHAT_REPLY_ATTEMPTS", "").strip()
    try:
        return max(1, min(MAX_REPLY_ATTEMPTS, int(raw))) if raw else DEFAULT_REPLY_ATTEMPTS
    except ValueError:
        return DEFAULT_REPLY_ATTEMPTS

_bound_root: Path | None = None
_lock = threading.RLock()


class CuliniaError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


PERSONA_CORE = f"""Tu es Culinia, la cheffe de brigade et intendante cuisine / planification des repas de Transfert HQ pour le Maître (Marc-Antoine).
Tu es distincte de {hq_personas.others_line('culinia')} : ta mémoire et ton univers sont entièrement dédiés à sa cuisine, ses recettes, ses stocks alimentaires, ses lots qui périment et ses menus.
Ta personnalité :
- Tempérament de vraie cheffe passionnée : vive, gourmande, un brin autoritaire devant les fourneaux mais tendre et taquine avec le Maître (« Maître » / « Master »).
- Obsédée par le goût, la saisie, l'assaisonnement, les herbes fraîches et le zéro gaspillage : tu le taquines s'il laisse un frigo vide ou s'il néglige un ingrédient qui périme, et tu commentes volontiers ses recettes (accords, petits twists de chef, temps de cuisson).
- Réponds en français s'il écrit en français, en anglais s'il écrit en anglais. Sois concise, vivante et appétissante.
- N'invente JAMAIS de produits, recettes, quantités ou dates de péremption : appelle d'abord tes outils `list_inventory`, `list_lots`, `list_products`, `list_recipes`, `list_meal_plans`, `list_shopping_lists` ou `get_meal_plan`.
- Quand le Maître demande des idées de recettes avec ce qu'il a en inventaire, inspecte `list_inventory` ET `list_lots` / `list_products` (et `list_recipes`), puis propose des recettes concrètes basées sur les ingrédients réellement disponibles (en signalant ce qu'il faudrait acheter si un ingrédient clé manque).
- IMPORTANT : dès que tu proposes une ou plusieurs recettes concrètes au Maître (notamment depuis son inventaire ou pour le dîner), appelle SYSTÉMATIQUEMENT `fetch_recipe_image` pour chaque plat proposé (max 3 photos par réponse) afin qu'il voie à quoi ça ressemble ! Si la recherche en français échoue, essaie le nom du plat en anglais.
"""

PERSONA_CORE += "\n" + hq_personas.quirks_line("culinia")


TOOL_SCHEMA = """Réponds UNIQUEMENT en JSON valide (sans bloc markdown) avec cette structure :
{"reply":"réponse pour le Maître","tools":[{"name":"tool_name","args":{...}}]}
`tools` peut être [] si aucune inspection supplémentaire n'est requise. Max 3 outils par tour.
Outils autorisés :
- list_inventory args:{} -> Liste les objets/aliments et emplacements de l'onglet Inventaire (hq_inventory).
- list_recipes args:{} -> Liste les recettes enregistrées dans l'onglet Repas (HQ Meals).
- list_meal_plans args:{} -> Liste les plans de repas hebdomadaires enregistrés dans HQ Meals.
- create_meal_recipe args:{"title":"...","servings":2,"leftover_policy":"none|freeze|plan_next","ingredients":[{"name":"...","qty_milli":200000,"unit":"g|ml|each|serving"}],"steps":["..."]} -> Crée ou met à jour une vraie fiche recette dans l'onglet Repas (unit ∈ {g, ml, each, serving}; 1 unité = 1000 milli).
- save_meal_calendar args:{"period_start":"YYYY-MM-DD","period_end":"YYYY-MM-DD","slots":[{"date":"YYYY-MM-DD","meal":"breakfast|lunch|dinner|snack","recipe_id":"...","notes":"..."}]} -> Remplit le calendrier officiel de l'onglet Repas (fusionne/met à jour le plan de la semaine si existant).
- build_plan_grocery_list args:{"plan_id":"...","mode":"preview|commit","subtract_available_stock":true} -> Prévisualise ou génère la liste d'épicerie des ingrédients manquants pour un plan de repas.
- scale_recipe_portions args:{"recipe_id":"...","target_servings":4,"save":false} -> Recalcule les quantités d'une recette pour N portions (et l'enregistre si save=true).
- get_food_budget args:{"month":"YYYY-MM"} -> Consulte hq_finances (résumé et enveloppes) pour suivre le budget alimentation/repas.
- fetch_recipe_image args:{"query":"Nom du plat","recipe_id":"optionnel"} -> Cherche et télécharge une photo appétissante du plat pour l'afficher au Maître dans le chat.
- get_preferences args:{} -> Lit les préférences culinaires mémorisées du Maître (goûts, allergies, appareils, portions).
- save_preferences args:{"likes":["..."],"dislikes":["..."],"equipment":["..."],"dietary_notes":"...","household_size":2} -> Mémorise durablement les goûts, interdits, appareils et habitudes du Maître.
- list_products args:{} -> Liste les produits alimentaires enregistrés dans HQ Grocery.
- list_lots args:{} -> Liste les lots en stock avec quantités et dates d'expiration.
- list_shopping_lists args:{} -> Liste les listes d'épicerie existantes.
- list_merchants args:{} -> Liste les marchands / épiceries enregistrés.
- create_shopping_list args:{"name":"Courses semaine","notes":""} -> Crée une nouvelle liste d'épicerie (sur demande du Maître ou accord).
- get_meal_plan args:{} -> Lit le plan de repas hebdomadaire enregistré par Culinia.
- save_meal_plan args:{"days":{"lundi":"...","mardi":"..."},"note":"..."} -> Enregistre ou met à jour le plan de repas hebdomadaire.
Après avoir reçu les résultats d'un outil, synthétise clairement la situation avec tools:[].
"""


def bind(*, root: str | Path) -> None:
    global _bound_root
    _bound_root = Path(root)


def _state_dir() -> Path:
    base = _bound_root or Path(".")
    d = base / STATE_FOLDER
    d.mkdir(parents=True, exist_ok=True)
    return d


_IMAGE_NAME_RE = re.compile(r"^[a-f0-9]{16}\.(?:jpg|png|webp)\Z")


def _images_dir() -> Path:
    d = _state_dir() / "culinia_images"
    d.mkdir(parents=True, exist_ok=True)
    return d


def image_path(filename: str) -> Path:
    name = (filename or "").strip()
    if not _IMAGE_NAME_RE.fullmatch(name):
        raise CuliniaError("Image invalide", status=400, code="validation_error")
    p = _images_dir() / name
    if not p.is_file():
        raise CuliniaError("Image introuvable", status=404, code="not_found")
    return p


def _http_get_json_ext(url: str, timeout: int = 8) -> dict[str, Any] | None:
    req = urllib.request.Request(url, headers={"User-Agent": "TransfertHQ-Culinia/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            if resp.status >= 400:
                return None
            return json.loads(resp.read(2 * 1024 * 1024).decode("utf-8", errors="replace"))
    except Exception:
        return None


def _download_recipe_image(img_url: str, title: str, source: str, recipe_id: str = "") -> dict[str, Any] | None:
    req = urllib.request.Request(img_url, headers={"User-Agent": "TransfertHQ-Culinia/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            if resp.status >= 400:
                return None
            ctype = (resp.headers.get("Content-Type") or "").lower().split(";")[0].strip()
            ext = ".jpg"
            if ctype == "image/png" or img_url.lower().endswith(".png"):
                ext = ".png"
            elif ctype == "image/webp" or img_url.lower().endswith(".webp"):
                ext = ".webp"
            elif ctype and not ctype.startswith("image/"):
                return None
            raw = resp.read(6 * 1024 * 1024 + 1)
            if not raw or len(raw) > 6 * 1024 * 1024:
                return None
    except Exception:
        return None
    digest = hashlib.sha256(img_url.encode("utf-8")).hexdigest()[:16]
    fname = f"{digest}{ext}"
    out = _images_dir() / fname
    tmp = out.with_suffix(".tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, out)
    return {
        "url": f"/api/culinia/image/{fname}",
        "title": title[:120],
        "source": source,
        "recipe_id": recipe_id,
    }


def _fetch_recipe_image_impl(query: str, recipe_id: str = "") -> dict[str, Any]:
    q = re.sub(r"\s+", " ", (query or "").strip())[:120]
    if not q:
        return {"ok": False, "error": "query requise"}

    # 1. TheMealDB public API (try full query, then longest keyword)
    candidates = [q]
    words = [w for w in re.split(r"[\s,'’]+", q) if len(w) >= 4]
    if len(words) > 1:
        candidates.append(max(words, key=len))
    for cand in candidates:
        data = _http_get_json_ext(
            "https://www.themealdb.com/api/json/v1/1/search.php?s=" + urllib.parse.quote(cand)
        )
        meals = (data or {}).get("meals") if isinstance(data, dict) else None
        if isinstance(meals, list) and meals:
            m0 = meals[0]
            thumb = str(m0.get("strMealThumb") or "").strip()
            if thumb.startswith("https://"):
                saved = _download_recipe_image(thumb, str(m0.get("strMeal") or q), "TheMealDB", recipe_id)
                if saved:
                    return {"ok": True, **saved}

    # 2. Wikipedia FR / EN REST summary thumbnail fallback
    slug = urllib.parse.quote(q.replace(" ", "_"))
    for lang in ("fr", "en"):
        data = _http_get_json_ext(f"https://{lang}.wikipedia.org/api/rest_v1/page/summary/{slug}")
        if isinstance(data, dict):
            thumb = ((data.get("thumbnail") or {}).get("source") or "").strip()
            if thumb.startswith("https://"):
                saved = _download_recipe_image(thumb, str(data.get("title") or q), f"Wikipedia ({lang})", recipe_id)
                if saved:
                    return {"ok": True, **saved}

    return {"ok": False, "error": f"Aucune photo trouvée pour « {q} »"}


def _load_json(filename: str, default: dict[str, Any]) -> dict[str, Any]:
    p = _state_dir() / filename
    if not p.is_file():
        return dict(default)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception as exc:
        # Present but unparseable: report it instead of returning defaults that a
        # later write would turn into an overwrite.
        raise CuliniaError("état illisible — fichier conservé", status=409, code="state_unreadable") from exc
    if not isinstance(data, dict):
        raise CuliniaError("état illisible — fichier conservé", status=409, code="state_unreadable")
    return data


def _save_json(filename: str, data: dict[str, Any]) -> None:
    p = _state_dir() / filename
    try:
        # hq_state refuses to replace a file that is present but unreadable.
        hq_state.write_json_atomic(p, data)
    except RuntimeError as exc:
        raise CuliniaError(str(exc), status=409, code="state_unreadable") from exc


def _thread_revision(data: Any) -> int:
    rev = data.get("revision", 0) if isinstance(data, dict) else 0
    return rev if isinstance(rev, int) and not isinstance(rev, bool) and rev >= 0 else 0


def _thread_epoch(data: Any) -> int:
    """Conversation generation: only clear_thread() advances it."""
    epoch = data.get("clear_epoch", 0) if isinstance(data, dict) else 0
    return epoch if isinstance(epoch, int) and not isinstance(epoch, bool) and epoch >= 0 else 0


def get_thread() -> dict[str, Any]:
    with _lock:
        data = _load_json(THREAD_FILE, {"messages": []})
        msgs = data.get("messages")
        return {"messages": list(msgs) if isinstance(msgs, list) else [],
                "revision": _thread_revision(data), "clear_epoch": _thread_epoch(data)}


def _thread_schema_ok(data: Any) -> bool:
    if not isinstance(data, dict) or "messages" not in data:
        return False
    for key in ("revision", "clear_epoch"):
        if key in data and (isinstance(data[key], bool)
                            or not isinstance(data[key], int) or data[key] < 0):
            return False
    msgs = data["messages"]
    if not isinstance(msgs, list):
        return False
    return all(isinstance(m, dict) and m.get("role") in ("user", "assistant")
               and isinstance(m.get("text"), str) for m in msgs)


def _thread_unreadable() -> bool:
    """True when the thread exists but is not a valid message list (never replaced)."""
    p = _state_dir() / THREAD_FILE
    if not p.is_file():
        return False
    try:
        return not _thread_schema_ok(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        return True


def _save_thread(messages: list[dict[str, Any]]) -> None:
    """Replace the thread and advance the epoch so in-flight replies are cancelled."""
    with _lock:
        if _thread_unreadable():
            raise CuliniaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
        data = _load_json(THREAD_FILE, {"messages": []})
        updated = dict(data)
        updated.update({"messages": messages[-MAX_THREAD:],
                        "revision": _thread_revision(data) + 1,
                        "clear_epoch": _thread_epoch(data) + 1})
        _save_json(THREAD_FILE, updated)


def _append_turn(turn: list[dict[str, Any]], base_revision: int, base_epoch: int = 0) -> bool:
    """Append a completed turn without replacing turns saved meanwhile.

    ``base_revision`` is the revision read before the model call. The file is
    reloaded under the lock; if it moved, the newer turns are kept and this turn
    is appended after them. Returns True when the append had to rebase. Returns
    False without writing when ``base_epoch`` no longer matches: the conversation
    was cleared, so this turn belongs to the previous one and is dropped.
    """
    with _lock:
        if _thread_unreadable():
            raise CuliniaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
        data = _load_json(THREAD_FILE, {"messages": []})
        if _thread_epoch(data) != base_epoch:
            return False
        current = list(data["messages"])
        rebased = _thread_revision(data) != base_revision
        updated = dict(data)
        updated.update({"messages": (current + list(turn))[-MAX_THREAD:],
                        "revision": _thread_revision(data) + 1})
        _save_json(THREAD_FILE, updated)
    return rebased


def _append_turn_if_current(turn: list[dict[str, Any]], base_revision: int, base_epoch: int = 0) -> bool:
    """Atomically append only if the thread is still in the same generation and
    at ``base_revision``.

    Revision and epoch are compared and advanced under one lock, so a turn cannot
    land between the check and the write. The revision detects a replacement once
    the thread is at its retention cap; the epoch detects a clear, which must
    cancel the reply instead of regenerating into the emptied conversation.
    Returns False without writing when either moved.
    """
    with _lock:
        if _thread_unreadable():
            raise CuliniaError("conversation illisible — fichier conservé", status=409, code="state_unreadable")
        data = _load_json(THREAD_FILE, {"messages": []})
        if _thread_epoch(data) != base_epoch:
            return False
        current = list(data["messages"])
        revision = _thread_revision(data)
        if revision != base_revision:
            return False
        updated = dict(data)
        updated.update({"messages": (current + list(turn))[-MAX_THREAD:], "revision": revision + 1})
        _save_json(THREAD_FILE, updated)
    return True


def clear_thread() -> dict[str, Any]:
    with _lock:
        _save_thread([])
        return {"ok": True, "messages": []}


def _prefs_schema_ok(data: Any) -> bool:
    """A parseable object is not enough: a field of the wrong type would be
    normalised on the next save and lose its original value."""
    if not isinstance(data, dict):
        return False
    for key in ("likes", "dislikes", "equipment"):
        if key in data and not (isinstance(data[key], list) and all(isinstance(x, str) for x in data[key])):
            return False
    for key in ("dietary_notes", "updated_at"):
        if key in data and not isinstance(data[key], str):
            return False
    if "household_size" in data and (isinstance(data["household_size"], bool)
                                     or not isinstance(data["household_size"], int)):
        return False
    return True


def _prefs_unreadable() -> bool:
    """True when the saved preferences exist but cannot be read safely (never replaced)."""
    p = _state_dir() / PREFS_FILE
    if not p.is_file():
        return False
    try:
        return not _prefs_schema_ok(json.loads(p.read_text(encoding="utf-8")))
    except Exception:
        return True


def _load_prefs() -> dict[str, Any]:
    with _lock:
        data = _load_json(PREFS_FILE, {
            "likes": [],
            "dislikes": [],
            "equipment": [],
            "dietary_notes": "",
            "household_size": 1,
        })
        if not _prefs_schema_ok(data):
            raise CuliniaError("préférences illisibles — fichier conservé", status=409, code="state_unreadable")
        return {
            "likes": [str(x).strip()[:80] for x in (data.get("likes") or []) if str(x).strip()][:30],
            "dislikes": [str(x).strip()[:80] for x in (data.get("dislikes") or []) if str(x).strip()][:30],
            "equipment": [str(x).strip()[:80] for x in (data.get("equipment") or []) if str(x).strip()][:30],
            "dietary_notes": str(data.get("dietary_notes") or "").strip()[:400],
            "household_size": max(1, min(20, int(data.get("household_size") or 1))) if str(data.get("household_size") or "").isdigit() else 1,
            "updated_at": str(data.get("updated_at") or ""),
        }


def _prefs_prompt_block() -> str:
    # Checked first: an unreadable file now raises from _load_prefs instead of
    # being silently replaced by defaults.
    if _prefs_unreadable():
        return "\nPréférences illisibles : fichier conservé, non modifié. Demande au Maître de le vérifier.\n"
    p = _load_prefs()
    parts = []
    if p["likes"]:
        parts.append("Aime : " + ", ".join(p["likes"]))
    if p["dislikes"]:
        parts.append("À éviter / n'aime pas : " + ", ".join(p["dislikes"]))
    if p["equipment"]:
        parts.append("Équipement cuisine : " + ", ".join(p["equipment"]))
    if p["dietary_notes"]:
        parts.append("Notes alimentaires : " + p["dietary_notes"])
    if p["household_size"] > 1:
        parts.append(f"Portions habituelles : {p['household_size']} personne(s)")
    if not parts:
        return ""
    return "\nPréférences mémorisées du Maître :\n- " + "\n- ".join(parts) + "\n"


def _match_grocery_product_id(name: str, unit: str, products: list[dict[str, Any]]) -> str | None:
    want = re.sub(r"\s+", " ", (name or "").strip().lower())
    if not want or not products:
        return None
    exact: list[str] = []
    fuzzy: list[str] = []
    for p in products:
        if str(p.get("canonical_unit") or "").lower() != unit:
            continue
        pname = re.sub(r"\s+", " ", str(p.get("name") or "").strip().lower())
        pid = str(p.get("id") or "")
        if not pname or not pid:
            continue
        if pname == want:
            exact.append(pid)
        elif want in pname or pname in want:
            fuzzy.append(pid)
    if len(exact) == 1:
        return exact[0]
    if len(fuzzy) == 1:
        return fuzzy[0]
    return None


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    try:
        if name == "list_inventory":
            code, payload = hq_inventory.http_get({})
            if code < 400 and isinstance(payload, dict):
                places = {
                    str(p.get("id") or ""): str(p.get("name") or "")
                    for p in (payload.get("places") or [])
                    if isinstance(p, dict)
                }
                compact = []
                for it in (payload.get("items") or [])[:120]:
                    if not isinstance(it, dict):
                        continue
                    compact.append({
                        "name": it.get("name"),
                        "qty": it.get("qty"),
                        "unit": it.get("unit"),
                        "place": places.get(str(it.get("place_id") or ""), ""),
                        "tags": it.get("tags") or [],
                        "note": (it.get("note") or "")[:100],
                    })
                return {"name": name, "ok": True, "result": {"count": len(payload.get("items") or []), "items": compact}}
            return {"name": name, "ok": False, "result": payload}

        if name == "list_recipes":
            code, payload = hq_meals.http_get("/api/meals/recipes")
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "list_meal_plans":
            code, payload = hq_meals.http_get("/api/meals/plans")
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "create_meal_recipe":
            title = str(args.get("title") or "").strip()[:160]
            if not title:
                return {"name": name, "ok": False, "error": "title requis"}
            try:
                servings = max(1, min(100, int(args.get("servings") or 2)))
            except Exception:
                servings = 2
            policy = str(args.get("leftover_policy") or "none").strip()
            if policy not in ("none", "freeze", "plan_next"):
                policy = "none"
            grocery_products: list[dict[str, Any]] = []
            try:
                gc, gp = hq_grocery.http_get("/api/grocery/products")
                if gc < 400 and isinstance(gp, dict):
                    grocery_products = [p for p in (gp.get("items") or gp.get("products") or []) if isinstance(p, dict)]
            except Exception:
                grocery_products = []
            raw_ings = args.get("ingredients") if isinstance(args.get("ingredients"), list) else []
            clean_ings = []
            for ing in raw_ings[:100]:
                if not isinstance(ing, dict):
                    continue
                iname = str(ing.get("name") or "").strip()[:160]
                if not iname:
                    continue
                unit = str(ing.get("unit") or "each").strip().lower()
                if unit not in ("g", "ml", "each", "serving"):
                    unit = "each"
                if "qty_milli" in ing and ing.get("qty_milli") is not None:
                    try:
                        qm = max(1, int(ing["qty_milli"]))
                    except Exception:
                        qm = 1000
                elif "qty" in ing and ing.get("qty") is not None:
                    try:
                        qm = max(1, int(round(float(ing["qty"]) * 1000)))
                    except Exception:
                        qm = 1000
                else:
                    qm = 1000
                pid = ing.get("product_id") or _match_grocery_product_id(iname, unit, grocery_products)
                item: dict[str, Any] = {
                    "name": iname,
                    "qty_milli": qm,
                    "unit": unit,
                    "optional": bool(ing.get("optional", False)),
                }
                if pid:
                    item["product_id"] = pid
                clean_ings.append(item)
            raw_steps = args.get("steps") if isinstance(args.get("steps"), list) else []
            clean_steps = [str(s).strip()[:2000] for s in raw_steps[:80] if str(s).strip()]
            body: dict[str, Any] = {
                "title": title,
                "servings": servings,
                "leftover_policy": policy,
                "ingredients": clean_ings,
                "steps": clean_steps,
            }
            if args.get("id") and args.get("rev"):
                body["id"] = args["id"]
                body["rev"] = int(args["rev"])
            code, payload = hq_meals.http_post("/api/meals/recipes", body)
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "save_meal_calendar":
            today = datetime.now().date()
            monday = today - timedelta(days=today.weekday())
            sunday = monday + timedelta(days=6)
            ps = str(args.get("period_start") or monday.isoformat()).strip()
            pe = str(args.get("period_end") or sunday.isoformat()).strip()
            slots_in = args.get("slots") if isinstance(args.get("slots"), list) else []
            clean_slots = []
            for s in slots_in[:400]:
                if not isinstance(s, dict):
                    continue
                sd = str(s.get("date") or "").strip()
                meal = str(s.get("meal") or "dinner").strip().lower()
                if meal not in ("breakfast", "lunch", "dinner", "snack"):
                    meal = "dinner"
                if not sd:
                    continue
                slot: dict[str, Any] = {"date": sd, "meal": meal, "recipe_id": s.get("recipe_id") or None}
                if s.get("notes"):
                    slot["notes"] = str(s["notes"]).strip()[:500]
                clean_slots.append(slot)
            plan_body: dict[str, Any] = {"period_start": ps, "period_end": pe, "slots": clean_slots}
            gc, gp = hq_meals.http_get("/api/meals/plans")
            if gc < 400 and isinstance(gp, dict):
                existing = next(
                    (p for p in (gp.get("items") or []) if p.get("period_start") == ps and p.get("period_end") == pe),
                    None,
                )
                if existing:
                    plan_body["id"] = existing["id"]
                    plan_body["rev"] = existing["rev"]
                    merged = {(sl.get("date"), sl.get("meal")): sl for sl in (existing.get("slots") or []) if isinstance(sl, dict)}
                    for sl in clean_slots:
                        merged[(sl["date"], sl["meal"])] = sl
                    plan_body["slots"] = list(merged.values())
            code, payload = hq_meals.http_post("/api/meals/plans", plan_body)
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "build_plan_grocery_list":
            plan_id = str(args.get("plan_id") or "").strip()
            if not plan_id:
                gc, gp = hq_meals.http_get("/api/meals/plans")
                items = (gp.get("items") or []) if gc < 400 and isinstance(gp, dict) else []
                if items:
                    plan_id = str(items[0].get("id") or "")
            if not plan_id:
                return {"name": name, "ok": False, "error": "Aucun plan de repas trouvé (plan_id requis)"}
            mode = str(args.get("mode") or "preview").strip()
            if mode not in ("preview", "commit"):
                mode = "preview"
            sub = bool(args.get("subtract_available_stock", True))
            code, payload = hq_meals.http_post(
                f"/api/meals/plans/{plan_id}/build-list",
                {"mode": mode, "subtract_available_stock": sub},
            )
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "scale_recipe_portions":
            rid = str(args.get("recipe_id") or "").strip()
            target_s = max(1, min(100, int(args.get("target_servings") or 2)))
            do_save = bool(args.get("save", False))
            rc, rp = hq_meals.http_get("/api/meals/recipes")
            if rc >= 400 or not isinstance(rp, dict):
                return {"name": name, "ok": False, "result": rp}
            recipes = rp.get("items") or []
            rec = next((r for r in recipes if r.get("id") == rid), None)
            if rec is None and args.get("title"):
                want = str(args["title"]).strip().lower()
                rec = next((r for r in recipes if want in str(r.get("title") or "").lower()), None)
            if rec is None:
                return {"name": name, "ok": False, "error": "Recette introuvable"}
            base_s = max(1, int(rec.get("servings") or 1))
            factor = target_s / base_s
            scaled_ings = []
            for ing in rec.get("ingredients") or []:
                if not isinstance(ing, dict):
                    continue
                new_ing = dict(ing)
                new_ing["qty_milli"] = max(1, int(round(int(ing.get("qty_milli") or 1000) * factor)))
                scaled_ings.append(new_ing)
            out_rec = {
                "id": rec["id"],
                "title": rec["title"],
                "base_servings": base_s,
                "target_servings": target_s,
                "ingredients": scaled_ings,
                "steps": rec.get("steps") or [],
            }
            if do_save:
                sc, sp = hq_meals.http_post(
                    "/api/meals/recipes",
                    {
                        "id": rec["id"],
                        "rev": rec["rev"],
                        "title": rec["title"],
                        "servings": target_s,
                        "leftover_policy": rec.get("leftover_policy") or "none",
                        "ingredients": scaled_ings,
                        "steps": rec.get("steps") or [],
                    },
                )
                return {"name": name, "ok": sc < 400, "result": sp}
            return {"name": name, "ok": True, "result": out_rec}

        if name == "get_food_budget":
            month = str(args.get("month") or datetime.now().strftime("%Y-%m")).strip()
            sc, sum_p = hq_finances.http_get("/api/finances/summary", {"month": [month]})
            ec, env_p = hq_finances.http_get("/api/finances/envelopes", {"month": [month]})
            return {
                "name": name,
                "ok": sc < 400,
                "result": {
                    "month": month,
                    "summary": sum_p if sc < 400 else None,
                    "envelopes": (env_p.get("items") or []) if ec < 400 and isinstance(env_p, dict) else [],
                },
            }

        if name == "list_products":
            code, payload = hq_grocery.http_get("/api/grocery/products")
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "list_lots":
            code, payload = hq_grocery.http_get("/api/grocery/lots")
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "list_shopping_lists":
            code, payload = hq_grocery.http_get("/api/grocery/lists")
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "list_merchants":
            code, payload = hq_grocery.http_get("/api/grocery/merchants")
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "create_shopping_list":
            lname = str(args.get("name") or "Liste de courses").strip()[:120]
            notes = str(args.get("notes") or "").strip()[:400]
            code, payload = hq_grocery.http_post("/api/grocery/lists", {"name": lname, "notes": notes})
            return {"name": name, "ok": code < 400, "result": payload}

        if name == "get_meal_plan":
            with _lock:
                plan = _load_json(MEAL_PLAN_FILE, {"days": {}, "note": "", "updated_at": ""})
            return {"name": name, "ok": True, "result": plan}

        if name == "save_meal_plan":
            days_in = args.get("days")
            note = str(args.get("note") or "").strip()[:500]
            with _lock:
                cur = _load_json(MEAL_PLAN_FILE, {"days": {}, "note": ""})
                if not (isinstance(cur.get("days", {}), dict)
                        and all(isinstance(k, str) and isinstance(v, str) for k, v in (cur.get("days") or {}).items())
                        and isinstance(cur.get("note", ""), str)
                        and isinstance(cur.get("updated_at", ""), str)):
                    raise CuliniaError("plan de repas illisible — fichier conservé", status=409, code="state_unreadable")
                days = dict(cur.get("days") or {})
                if isinstance(days_in, dict):
                    for k, v in days_in.items():
                        ks = str(k).strip().lower()[:32]
                        vs = str(v).strip()[:240]
                        if ks:
                            days[ks] = vs
                updated = {
                    "days": days,
                    "note": note or cur.get("note", ""),
                    "updated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                }
                _save_json(MEAL_PLAN_FILE, updated)
            return {"name": name, "ok": True, "result": updated}

        if name == "get_preferences":
            return {"name": name, "ok": True, "result": _load_prefs()}

        if name == "fetch_recipe_image":
            res = _fetch_recipe_image_impl(
                str(args.get("query") or ""),
                str(args.get("recipe_id") or "").strip()[:64],
            )
            return {"name": name, "ok": bool(res.get("ok")), "result": res}

        if name == "save_preferences":
            with _lock:
                cur = _load_prefs()
                for key in ("likes", "dislikes", "equipment"):
                    if key in args and isinstance(args.get(key), list):
                        cur[key] = [str(x).strip()[:80] for x in args[key] if str(x).strip()][:30]
                if "dietary_notes" in args:
                    cur["dietary_notes"] = str(args.get("dietary_notes") or "").strip()[:400]
                if "household_size" in args:
                    try:
                        cur["household_size"] = max(1, min(20, int(args["household_size"])))
                    except Exception:
                        pass
                cur["updated_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
                _save_json(PREFS_FILE, cur)
            return {"name": name, "ok": True, "result": cur}

        return {"name": name, "ok": False, "error": f"Outil inconnu: {name}"}
    except Exception as exc:
        return {"name": name, "ok": False, "error": str(exc)}


def _parse_model_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
        if isinstance(data, dict):
            reply = str(data.get("reply") or "").strip()
            tools = data.get("tools")
            if not isinstance(tools, list):
                tools = []
            clean_tools = []
            for t in tools:
                if isinstance(t, dict) and isinstance(t.get("name"), str):
                    targs = t.get("args") if isinstance(t.get("args"), dict) else {}
                    clean_tools.append({"name": t["name"].strip(), "args": targs})
            return {"reply": reply, "tools": clean_tools}
    except Exception:
        pass
    return {"reply": text, "tools": []}


def _history_contents(messages: list[dict[str, Any]], user_text: str) -> list[dict[str, Any]]:
    contents: list[dict[str, Any]] = []
    for m in messages[-16:]:
        role = "model" if m.get("role") == "assistant" else "user"
        txt = str(m.get("text") or "").strip()
        if txt:
            contents.append({"role": role, "parts": [{"text": txt}]})
    contents.append({"role": "user", "parts": [{"text": user_text}]})
    return contents


def status_summary() -> dict[str, Any]:
    plan = _load_json(MEAL_PLAN_FILE, {"days": {}})
    planned_days = len([v for v in (plan.get("days") or {}).values() if v])
    return {
        "ok": True,
        "headline": f"{planned_days} jour(s) planifié(s)" if planned_days else "Brigade prête · En cuisine",
        "planned_days": planned_days,
        "thread": get_thread().get("messages", []),
        "reply_contention": _contention_snapshot(),
    }


def chat(message: Any) -> dict[str, Any]:
    import hq_ai

    if not isinstance(message, str) or not message.strip():
        raise CuliniaError("Message requis")
    text = message.strip()[:MAX_MESSAGE]

    thread = get_thread()
    messages = list(thread.get("messages") or [])
    base_revision = thread.get("revision", 0)   # revision this reply is based on
    base_epoch = thread.get("clear_epoch", 0)   # conversation generation
    contents = _history_contents(messages, text)
    history_len = len(contents)

    system = f"{PERSONA_CORE}{_prefs_prompt_block()}\n{TOOL_SCHEMA}"
    tools_used: list[str] = []
    images: list[dict[str, Any]] = []
    reply = ""
    model = None

    for round_idx in range(MAX_ROUNDS):
        final_round = round_idx == MAX_ROUNDS - 1 or len(tools_used) >= MAX_TOTAL_TOOLS
        instructions = system
        if final_round:
            instructions += "\nDernier tour : réponds maintenant au Maître avec tools:[]."

        raw, model = hq_ai.generate(
            hq_ai.ASK_CHAIN,
            contents,
            system_instruction=instructions,
            max_output_tokens=600,
            temperature=0.55,
            timeout=25,
        )
        parsed = _parse_model_json(raw)
        reply = parsed["reply"]
        req_tools = [] if final_round else parsed["tools"][:3]
        if not req_tools:
            break

        tool_results = []
        for t in req_tools:
            if len(tools_used) >= MAX_TOTAL_TOOLS:
                break
            tname = t["name"]
            tools_used.append(tname)
            tres = _execute_tool(tname, t["args"])
            tool_results.append(tres)
            if tname == "fetch_recipe_image" and tres.get("ok") and isinstance(tres.get("result"), dict):
                rimg = tres["result"]
                if rimg.get("url"):
                    images.append({"url": rimg["url"], "title": rimg.get("title", ""), "source": rimg.get("source", "")})

        contents.append({"role": "model", "parts": [{"text": raw}]})
        contents.append({
            "role": "user",
            "parts": [{"text": "Résultats outils:\n" + json.dumps(tool_results, ensure_ascii=False)[:12000]}],
        })

    if not reply:
        reply = "Les fourneaux sont prêts, Maître — dis-moi ce qui te ferait envie."
    tool_tail = contents[history_len:]      # tool calls and results already executed

    def _turn(answer: str) -> list[dict[str, Any]]:
        stamp = time.time()
        assistant_msg: dict[str, Any] = {
            "role": "assistant",
            "text": answer,
            "ts": stamp,
            "tools_used": tools_used,
            "model": model,
        }
        if images:
            assistant_msg["images"] = images
        return [{"role": "user", "text": text, "ts": stamp}, assistant_msg]

    rebases = 0
    reconciled = 0
    fallback = False
    cancelled = False
    saved = False
    for _ in range(_reply_attempts()):
        current = get_thread()
        if current["clear_epoch"] != base_epoch:
            # The conversation was cleared: the reply belongs to the old one and
            # must not be regenerated into the empty thread or re-inserted.
            cancelled = True
            log.warning("chat reply discarded: the conversation was cleared while generating")
            break
        if current["revision"] != base_revision:
            # A turn landed while this reply was generated: answer the merged
            # conversation, keeping the tool results already obtained (never
            # replaying them: they may have changed real state).
            rebases += 1
            try:
                raw, regen_model = hq_ai.generate(
                    hq_ai.ASK_CHAIN,
                    _history_contents(current["messages"], text) + tool_tail,
                    system_instruction=system + "\nD'autres messages sont arrivés pendant ta réponse : "
                                                "tiens-en compte et réponds maintenant avec tools:[].",
                    max_output_tokens=600,
                    temperature=0.55,
                    timeout=25,
                )
            except Exception as exc:
                # The earlier reply (with its tool results) is still valid; save
                # it through the fallback instead of failing the request.
                log.warning("chat regeneration failed (%s); keeping the earlier reply", type(exc).__name__)
                break
            parsed = _parse_model_json(raw)
            answer = (parsed.get("reply") or "").strip()
            if not answer or parsed.get("tools"):
                # A tool request or empty reply is not a reconciled answer; keep
                # the earlier reply and report the fallback rather than calling
                # the stale answer reconciled.
                log.warning("chat regeneration returned no final answer; keeping the earlier reply")
                break
            reply = answer
            model = regen_model
            reconciled += 1
            base_revision = current["revision"]
        if _append_turn_if_current(_turn(reply), base_revision, base_epoch):
            saved = True
            break
    if not saved and not cancelled:
        # Keep every turn rather than loop forever; the reply is reported as a fallback.
        if _append_turn(_turn(reply), base_revision, base_epoch):
            fallback = True
            log.warning("chat reply not reconciled after %d regeneration(s): kept the earlier answer", rebases)
        else:
            cancelled = True
            log.warning("chat reply discarded: the conversation was cleared before it could be saved")
    _note_contention(rebases, fallback)

    return {
        "ok": True,
        "reply": reply,
        "tools_used": tools_used,
        "images": images,
        "model": model,
        "messages": get_thread().get("messages", [])[-MAX_THREAD:],
        "reconciled": reconciled,
        "regenerations": rebases,
        "fallback_append": fallback,
        "cancelled": cancelled,
    }


def http_get(path: str) -> tuple[int, dict[str, Any]]:
    try:
        if path == "/api/culinia/status":
            return 200, status_summary()
        if path == "/api/culinia/thread":
            return 200, {"ok": True, **get_thread()}
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except CuliniaError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}


def _kitchen_snapshot() -> dict[str, Any]:
    snap: dict[str, Any] = {"recipes": [], "lots_count": 0, "products_count": 0, "planned_days": 0}
    try:
        rc, rp = hq_meals.http_get("/api/meals/recipes")
        if rc < 400 and isinstance(rp, dict):
            items = rp.get("items") or []
            snap["recipes"] = [str(r.get("title") or r.get("name") or "").strip() for r in items[:8] if isinstance(r, dict)]
    except Exception:
        pass
    try:
        pc, pp = hq_grocery.http_get("/api/grocery/products")
        if pc < 400 and isinstance(pp, dict):
            snap["products_count"] = len(pp.get("items") or pp.get("products") or [])
    except Exception:
        pass
    try:
        lc, lp = hq_grocery.http_get("/api/grocery/lots")
        if lc < 400 and isinstance(lp, dict):
            lots = lp.get("items") or lp.get("lots") or []
            snap["lots_count"] = len(lots)
            snap["sample_lots"] = [str(x.get("product_name") or x.get("name") or "").strip() for x in lots[:5] if isinstance(x, dict)]
    except Exception:
        pass
    try:
        plan = _load_json(MEAL_PLAN_FILE, {"days": {}})
        snap["planned_days"] = len([v for v in (plan.get("days") or {}).values() if v])
    except Exception:
        pass
    return snap


def _fallback_ambient(snap: dict[str, Any], ctx: dict[str, Any]) -> str:
    recipe = str(ctx.get("recipe_title") or "").strip()
    nsfw = bool(ctx.get("nsfw"))
    if recipe:
        if nsfw:
            return f"Mmm, « {recipe} » ? Laisse-moi goûter la sauce en premier, Maître — juste en tablier, c'est encore meilleur."
        return f"« {recipe} »… bon choix, Maître ! Pense à bien saisir à feu vif et à goûter l'assaisonnement avant de servir."
    if snap.get("lots_count", 0) == 0 and not snap.get("recipes"):
        if nsfw:
            return "Le frigo est vide, Maître… tu me gardes en tablier sans rien à mijoter ? Passe aux courses avec moi."
        return "Maître, le garde-manger sonne creux ! On prépare une vraie liste de courses ou tu comptes vivre d'amour et d'eau fraîche ?"
    if snap.get("recipes"):
        r0 = snap["recipes"][0]
        return f"J'ai l'œil sur « {r0} », Maître — dis-moi quand tu veux qu'on lance la brigade ou qu'on ajuste le menu."
    return "Les couteaux sont affûtés et la poêle chauffe, Maître. Qu'est-ce qu'on mijote aujourd'hui ?"


def ambient(context: dict[str, Any] | None = None) -> dict[str, Any]:
    import hq_ai

    ctx = context if isinstance(context, dict) else {}
    snap = _kitchen_snapshot()
    recipe = str(ctx.get("recipe_title") or "").strip()[:120]
    meal_slot = str(ctx.get("meal_slot") or "").strip()[:80]
    trigger = str(ctx.get("trigger") or "timer").strip()[:24]
    nsfw = bool(ctx.get("nsfw"))
    hour = datetime.now().hour

    tone_hint = (
        "Mode tablier coquin/taquin activé : garde ta voix de cheffe passionnée avec une touche sensuelle et taquine envers le Maître (sans vulgarité explicite)."
        if nsfw
        else "Mode brigade chaleureuse : cheffe vive, gourmande, un brin exigeante et taquine envers le Maître."
    )
    prompt = (
        f"Contexte cuisine HQ (heure locale ~{hour}h, déclencheur={trigger}) :\n"
        f"- Recette regardée à l'écran : {recipe or 'aucune'}\n"
        f"- Créneau sélectionné : {meal_slot or 'aucun'}\n"
        f"- Recettes enregistrées : {', '.join(snap.get('recipes') or []) or 'aucune'}\n"
        f"- Produits en stock : {snap.get('products_count', 0)}, lots : {snap.get('lots_count', 0)}\n"
        f"- Jours planifiés Culinia : {snap.get('planned_days', 0)}\n\n"
        f"{tone_hint}\n"
        "Écris UNE seule bulle spontanée (1 à 2 phrases max, <= 165 caractères, en français, sans guillemets ni markdown) pour interpeller le Maître sur sa recette, ses stocks ou son appétit."
    )
    line = ""
    model = None
    try:
        chain = getattr(hq_ai, "FAST_CHAIN", hq_ai.ASK_CHAIN)
        raw, model = hq_ai.generate(
            chain,
            [{"role": "user", "parts": [{"text": prompt}]}],
            system_instruction=PERSONA_CORE,
            max_output_tokens=120,
            temperature=0.82,
            timeout=12,
        )
        line = (raw or "").strip().strip('"«»')
        if len(line) > 210:
            line = line[:207].rstrip() + "…"
    except Exception:
        line = ""

    if not line:
        line = _fallback_ambient(snap, ctx)

    return {"ok": True, "line": line, "model": model, "recipe": recipe}


def http_post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    try:
        if not isinstance(body, dict):
            raise CuliniaError("Corps JSON invalide")
        if path == "/api/culinia/chat":
            return 200, chat(body.get("message"))
        if path == "/api/culinia/ambient":
            return 200, ambient(body)
        if path == "/api/culinia/clear":
            return 200, clear_thread()
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except CuliniaError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
