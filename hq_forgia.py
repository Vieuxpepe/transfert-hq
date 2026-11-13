"""Forgia — HQ Forge Master, Visual Alchemist & Prompt Architect AI.

Memory is separate from every other HQ assistant (roster: hq_personas).
Strictly read-only on Forge state (status, catalog, progress, presets, jobs) — never writes
/sdapi/v1/options or interrupts/skips the owner's Forge.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any
import json
import re
import threading
import time

import hq_forge
import hq_forge_jobs
import hq_forge_presets
import hq_personas
import hq_state

STATE_FOLDER = ".hq-forge"
THREAD_FILE = "forgia_thread.json"
PREFS_FILE = "forgia_prefs.json"
MAX_THREAD = 40
MAX_MESSAGE = 4000
MAX_ROUNDS = 4
MAX_TOTAL_TOOLS = 6

_bound_root: Path | None = None
_lock = threading.RLock()


class ForgiaError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


PERSONA_CORE = f"""Tu es Forgia, la maître-forgeronne et architecte de prompts de l'onglet Forge dans Transfert HQ pour le Maître (Marc-Antoine).
Tu es distincte de {hq_personas.others_line('forgia')} : ta mémoire est dédiée à ses créations visuelles, checkpoints, LoRAs, presets, files de jobs et prompts Stable Diffusion / Illustrious / SDXL.
Ta personnalité :
- Alchimiste visuelle passionnée et précise : œil vif sur la lumière, la composition, le cadrage, les poids de LoRA, le CFG, le sampler et les negative prompts.
- Chaleureuse, admirative de ses idées et un brin taquine dans l'atelier (« Maître » / « Master »).
- RÈGLE ABSOLUE : tu ne modifies JAMAIS les options globales de Forge, tu n'interromps jamais un rendu en cours. Tu inspectes en lecture seule et tu forges des prompts/conseils prêts à copier.
- Réponds en français s'il écrit en français, en anglais s'il écrit en anglais. Sois concise, visuelle et directement exploitable (mets les prompts entre backticks `...` pour qu'il puisse les copier facilement).
- N'invente JAMAIS un checkpoint, LoRA, preset ou job : appelle d'abord tes outils `get_forge_status`, `get_forge_catalog`, `list_presets`, `list_jobs` ou `get_preferences`.
"""

PERSONA_CORE += "\n" + hq_personas.quirks_line("forgia")


TOOL_SCHEMA = """Réponds UNIQUEMENT en JSON valide (sans bloc markdown) avec cette structure :
{"reply":"réponse pour le Maître","tools":[{"name":"tool_name","args":{...}}]}
`tools` peut être [] si aucune inspection supplémentaire n'est requise. Max 3 outils par tour.
Outils autorisés (lecture seule sur Forge) :
- get_forge_status args:{} -> État de Forge (connecté, checkpoint actif, progression en cours).
- get_forge_catalog args:{} -> Liste des checkpoints, samplers, schedulers, VAEs et LoRAs disponibles.
- get_forge_progress args:{} -> Progression du rendu en cours (pourcentage, ETA, job actif).
- list_presets args:{} -> Liste les presets enregistrés dans HQ Forge.
- list_jobs args:{} -> Liste les jobs Forge récents / en file.
- get_preferences args:{} -> Lit les préférences visuelles mémorisées du Maître (styles favoris, negative prompt type, checkpoints).
- save_preferences args:{"styles":["..."],"favorite_checkpoints":["..."],"negative_staples":"...","notes":"..."} -> Mémorise les goûts visuels et habitudes de prompt du Maître.
Après avoir reçu les résultats d'un outil, synthétise clairement la réponse avec tools:[].
"""


def bind(*, root: str | Path) -> None:
    global _bound_root
    _bound_root = Path(root)


def _state_dir() -> Path:
    base = _bound_root or Path(".")
    d = base / STATE_FOLDER
    d.mkdir(parents=True, exist_ok=True)
    return d


def _load_json(filename: str, default: dict[str, Any]) -> dict[str, Any]:
    p = _state_dir() / filename
    if not p.is_file():
        return dict(default)
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return dict(default)


def _save_json(filename: str, data: dict[str, Any]) -> None:
    p = _state_dir() / filename
    try:
        # hq_state refuses to replace a file that is present but unreadable.
        hq_state.write_json_atomic(p, data)
    except RuntimeError as exc:
        raise ForgiaError(str(exc), status=409, code="state_unreadable") from exc


def get_thread() -> dict[str, Any]:
    with _lock:
        data = _load_json(THREAD_FILE, {"messages": []})
        msgs = data.get("messages")
        return {"messages": list(msgs) if isinstance(msgs, list) else []}


def _save_thread(messages: list[dict[str, Any]]) -> None:
    with _lock:
        _save_json(THREAD_FILE, {"messages": messages[-MAX_THREAD:]})


def clear_thread() -> dict[str, Any]:
    with _lock:
        _save_thread([])
        return {"ok": True, "messages": []}


def _prefs_unreadable() -> bool:
    """True when the saved preferences exist but cannot be parsed (never replaced)."""
    p = _state_dir() / PREFS_FILE
    if not p.is_file():
        return False
    try:
        return not isinstance(json.loads(p.read_text(encoding="utf-8")), dict)
    except Exception:
        return True


def _load_prefs() -> dict[str, Any]:
    with _lock:
        data = _load_json(PREFS_FILE, {
            "styles": [],
            "favorite_checkpoints": [],
            "negative_staples": "",
            "notes": "",
        })
        return {
            "styles": [str(x).strip()[:80] for x in (data.get("styles") or []) if str(x).strip()][:25],
            "favorite_checkpoints": [str(x).strip()[:120] for x in (data.get("favorite_checkpoints") or []) if str(x).strip()][:15],
            "negative_staples": str(data.get("negative_staples") or "").strip()[:600],
            "notes": str(data.get("notes") or "").strip()[:400],
            "updated_at": str(data.get("updated_at") or ""),
        }


def _prefs_prompt_block() -> str:
    p = _load_prefs()
    if _prefs_unreadable():
        return "\nPréférences illisibles : fichier conservé, non modifié. Demande au Maître de le vérifier.\n"
    parts = []
    if p["styles"]:
        parts.append("Styles favoris : " + ", ".join(p["styles"]))
    if p["favorite_checkpoints"]:
        parts.append("Checkpoints préférés : " + ", ".join(p["favorite_checkpoints"]))
    if p["negative_staples"]:
        parts.append("Negative prompt habituel : " + p["negative_staples"])
    if p["notes"]:
        parts.append("Notes d'atelier : " + p["notes"])
    if not parts:
        return ""
    return "\nPréférences visuelles mémorisées du Maître :\n- " + "\n- ".join(parts) + "\n"


def _execute_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    root = _bound_root or Path(".")
    try:
        if name == "get_forge_status":
            st = hq_forge.status()
            return {"name": name, "ok": True, "result": st}

        if name == "get_forge_catalog":
            cat = hq_forge.catalog()
            def _pick(seq: Any, *keys: str, limit: int = 25) -> list[Any]:
                out = []
                for item in (seq or [])[:limit]:
                    if isinstance(item, dict):
                        val = next((item.get(k) for k in keys if item.get(k)), None)
                        out.append(val if val is not None else item)
                    else:
                        out.append(item)
                return out
            compact = {
                "checkpoints": _pick(cat.get("checkpoints"), "title", "model_name", limit=25),
                "samplers": _pick(cat.get("samplers"), "name", limit=20),
                "schedulers": _pick(cat.get("schedulers"), "name", limit=15),
                "loras": _pick(cat.get("loras"), "name", "alias", limit=35),
            }
            return {"name": name, "ok": True, "result": compact}

        if name == "get_forge_progress":
            prog = hq_forge.read_progress()
            return {"name": name, "ok": True, "result": prog}

        if name == "list_presets":
            presets = hq_forge_presets.list_presets(root)
            return {"name": name, "ok": True, "result": presets}

        if name == "list_jobs":
            rows = hq_forge_jobs.summary_rows(root)
            return {"name": name, "ok": True, "result": {"count": len(rows), "jobs": rows[:20]}}

        if name == "get_preferences":
            return {"name": name, "ok": True, "result": _load_prefs()}

        if name == "save_preferences":
            with _lock:
                cur = _load_prefs()
                for key in ("styles", "favorite_checkpoints"):
                    if key in args and isinstance(args.get(key), list):
                        cur[key] = [str(x).strip()[:120] for x in args[key] if str(x).strip()][:25]
                if "negative_staples" in args:
                    cur["negative_staples"] = str(args.get("negative_staples") or "").strip()[:600]
                if "notes" in args:
                    cur["notes"] = str(args.get("notes") or "").strip()[:400]
                cur["updated_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
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
    headline = "Atelier prêt · Enclume chaude"
    try:
        st = hq_forge.status()
        ckpt = str(st.get("checkpoint") or st.get("sd_model_checkpoint") or "").strip()
        if ckpt:
            headline = ckpt.split(".")[0][:38]
        elif st.get("online") is False:
            headline = "Forge en veille"
    except Exception:
        pass
    return {
        "ok": True,
        "headline": headline,
        "thread": get_thread().get("messages", []),
    }


def chat(message: Any) -> dict[str, Any]:
    import hq_ai

    if not isinstance(message, str) or not message.strip():
        raise ForgiaError("Message requis")
    text = message.strip()[:MAX_MESSAGE]

    thread = get_thread()
    messages = list(thread.get("messages") or [])
    contents = _history_contents(messages, text)

    system = f"{PERSONA_CORE}{_prefs_prompt_block()}\n{TOOL_SCHEMA}"
    tools_used: list[str] = []
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
            max_output_tokens=650,
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
            tool_results.append(_execute_tool(tname, t["args"]))

        contents.append({"role": "model", "parts": [{"text": raw}]})
        contents.append({
            "role": "user",
            "parts": [{"text": "Résultats outils:\n" + json.dumps(tool_results, ensure_ascii=False)[:12000]}],
        })

    if not reply:
        reply = "L'atelier est allumé, Maître — quel prompt ou rendu forge-t-on ?"

    now = time.time()
    messages.append({"role": "user", "text": text, "ts": now})
    messages.append({"role": "assistant", "text": reply, "ts": now, "tools_used": tools_used, "model": model})
    _save_thread(messages)

    return {
        "ok": True,
        "reply": reply,
        "tools_used": tools_used,
        "model": model,
        "messages": messages[-MAX_THREAD:],
    }


def _forge_snapshot() -> dict[str, Any]:
    snap: dict[str, Any] = {"online": False, "checkpoint": "", "progress": 0, "jobs_count": 0}
    try:
        st = hq_forge.status()
        snap["online"] = bool(st.get("online", True))
        snap["checkpoint"] = str(st.get("checkpoint") or st.get("sd_model_checkpoint") or "").strip()
    except Exception:
        pass
    try:
        pr = hq_forge.read_progress()
        snap["progress"] = float(pr.get("progress") or 0)
    except Exception:
        pass
    try:
        rows = hq_forge_jobs.summary_rows(_bound_root or Path("."))
        snap["jobs_count"] = len(rows)
    except Exception:
        pass
    return snap


def _fallback_ambient(snap: dict[str, Any], ctx: dict[str, Any]) -> str:
    nsfw = bool(ctx.get("nsfw"))
    ckpt = snap.get("checkpoint") or ""
    if snap.get("progress", 0) > 0.01:
        pct = int(round(snap["progress"] * 100))
        return f"Ça chauffe dans le creuset, Maître — rendu à {pct}%, j'ai hâte de voir le résultat."
    if ckpt:
        short = ckpt.split(".")[0][:32]
        if nsfw:
            return f"En tablier devant l'enclume avec {short}, Maître… dis-moi ce qu'on fait naître ce soir."
        return f"{short} est chargé et l'enclume est chaude, Maître. Besoin d'un prompt affûté ?"
    if nsfw:
        return "Juste mon tablier de cuir et mes lunettes, Maître… tu me lances une nouvelle idée de prompt ?"
    return "L'atelier Forge est prêt, Maître. Donne-moi une idée et je te taille un prompt chirurgical."


def ambient(context: dict[str, Any] | None = None) -> dict[str, Any]:
    import hq_ai

    ctx = context if isinstance(context, dict) else {}
    snap = _forge_snapshot()
    trigger = str(ctx.get("trigger") or "timer").strip()[:24]
    nsfw = bool(ctx.get("nsfw"))
    prompt_preview = str(ctx.get("prompt_preview") or "").strip()[:160]

    tone_hint = (
        "Mode tablier de cuir coquin/taquin activé : garde ta voix d'alchimiste visuelle avec une touche sensuelle et taquine envers le Maître (sans vulgarité explicite)."
        if nsfw
        else "Mode atelier chaleureux : maître-forgeronne passionnée de lumière, de prompts et de rendu."
    )
    prompt = (
        f"Contexte atelier Forge HQ (déclencheur={trigger}) :\n"
        f"- Forge en ligne : {snap['online']}\n"
        f"- Checkpoint actif : {snap['checkpoint'] or 'inconnu'}\n"
        f"- Progression : {int(round(snap['progress'] * 100))}%\n"
        f"- Jobs récents : {snap['jobs_count']}\n"
        f"- Extrait prompt à l'écran : {prompt_preview or 'aucun'}\n\n"
        f"{tone_hint}\n"
        "Écris UNE seule bulle spontanée (1 à 2 phrases max, <= 165 caractères, en français, sans guillemets ni markdown) pour interpeller le Maître sur son atelier ou ses prompts."
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

    return {"ok": True, "line": line, "model": model}


def http_get(path: str) -> tuple[int, dict[str, Any]]:
    try:
        if path == "/api/forgia/status":
            return 200, status_summary()
        if path == "/api/forgia/thread":
            return 200, {"ok": True, **get_thread()}
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except ForgiaError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}


def http_post(path: str, body: dict[str, Any]) -> tuple[int, dict[str, Any]]:
    try:
        if not isinstance(body, dict):
            raise ForgiaError("Corps JSON invalide")
        if path == "/api/forgia/chat":
            return 200, chat(body.get("message"))
        if path == "/api/forgia/ambient":
            return 200, ambient(body)
        if path == "/api/forgia/clear":
            return 200, clear_thread()
        return 404, {"ok": False, "code": "not_found", "error": "Route introuvable"}
    except ForgiaError as exc:
        return exc.status, {"ok": False, "code": exc.code, "error": str(exc)}
