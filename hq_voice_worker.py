"""Musica voice worker: lets this PC's GPU do Chatterbox synthesis for Transfert HQ.

Standard library only. Copy this file to the worker PC (for example C:\\TransfertWorker\\), next to a working
Chatterbox install and scripts/chatterbox_daemon.py (see docs/musica-voice-worker.md).

  py -3 hq_voice_worker.py pair --hq https://<hq>.<tailnet>.ts.net --name "Portable RTX 2060"
  py -3 hq_voice_worker.py run  --daemon-python C:\\AI\\Chatterbox\\venv\\Scripts\\python.exe ^
        --daemon-script C:\\TransfertWorker\\chatterbox_daemon.py --root C:\\AI\\Chatterbox
  py -3 hq_voice_worker.py status

The worker only polls HQ outbound. HQ never connects here and nothing listens on a network port: the Chatterbox
daemon stays on 127.0.0.1. A job names a voice and gives a text and three numbers; it never carries a path or a
command. The reference voice is fetched from HQ (it owns it) into <root>\\voices.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

VERSION = "2"
CREDS = Path(os.environ.get("LOCALAPPDATA") or Path.home()) / "TransfertHQ" / "voice-worker.json"
VOICE_RE = re.compile(r"^[a-z0-9_-]{1,40}$")
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
STOP = threading.Event()  # tests set it to end the loop


# ---- tiny HTTP helpers ---------------------------------------------------------------------------------------------

def post(url: str, payload: dict, *, token: str = "", timeout: float = 20.0) -> tuple[int, dict]:
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, json.dumps(payload).encode(), headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read() or b"{}")
        except ValueError:
            return exc.code, {}


def daemon_health(daemon: str) -> dict:
    try:
        with urllib.request.urlopen(daemon + "/health", timeout=6) as r:  # a daemon busy importing torch answers slowly
            return json.loads(r.read() or b"{}")
    except Exception:  # noqa: BLE001
        return {}


def gpu_info() -> dict:
    try:
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
                             capture_output=True, text=True, timeout=5, creationflags=NO_WINDOW).stdout.strip().splitlines()[0]
        name, total = [x.strip() for x in out.split(",")[:2]]
        return {"gpu": name, "vram_mb": int(float(total))}
    except Exception:  # noqa: BLE001
        return {}


def protect(path: Path) -> None:
    """Credentials readable by this user only (no inheritance), like the Forge worker's file."""
    try:
        subprocess.run(["icacls", str(path), "/inheritance:r", "/grant:r", f"{os.environ.get('USERNAME', '')}:F",
                        "SYSTEM:F", "Administrators:F"], capture_output=True, timeout=10, creationflags=NO_WINDOW)
    except Exception:  # noqa: BLE001
        pass


def load_creds() -> dict:
    try:
        data = json.loads(CREDS.read_text(encoding="utf-8"))
        return data if data.get("hq") and data.get("token") else {}
    except (OSError, ValueError):
        return {}


# ---- commands ------------------------------------------------------------------------------------------------------

def cmd_pair(args) -> int:
    hq = args.hq.rstrip("/")
    if args.code_file:
        code = Path(args.code_file).read_text(encoding="utf-8").strip()
    else:
        code = getpass.getpass("Code à usage unique (affiché dans HQ, Musique > La station) : ").strip()
    status, data = post(hq + "/voice-worker/v1/enroll",
                        {"code": code, "name": args.name, "info": {**gpu_info(), "version": VERSION}})
    if status != 200:
        print("Association refusée :", data.get("error") or status)
        return 1
    CREDS.parent.mkdir(parents=True, exist_ok=True)
    CREDS.write_text(json.dumps({"hq": hq, "token": f"{data['worker_id']}.{data['token']}", "name": args.name}), encoding="utf-8")
    protect(CREDS)
    print(f"Associé comme « {args.name} ». Identifiants dans {CREDS}")
    return 0


_last_spawn = 0.0
_spawned = None      # the daemon launcher this worker started (its child is the process that holds the port)
SPAWN_COOLDOWN = 240  # loading the model takes ~2 minutes: never start a second daemon while the first one loads


def start_daemon(args) -> None:
    """Start the local Chatterbox daemon, at most once per SPAWN_COOLDOWN (the model takes about two minutes to load).
    A live launcher is enough reason not to start another: /health can time out for a whole load on a busy PC, and two
    daemons would each load a model into VRAM (Windows lets both bind the port)."""
    global _last_spawn, _spawned
    if _spawned is not None and _spawned.poll() is None:
        return
    if not (args.daemon_python and args.daemon_script) or time.time() - _last_spawn < SPAWN_COOLDOWN:
        return
    _last_spawn = time.time()
    cmd = [args.daemon_python, "-I", args.daemon_script, "--host", "127.0.0.1", "--port", str(args.daemon_port)]
    if args.root:
        cmd += ["--root", args.root]
    _spawned = subprocess.Popen(cmd, creationflags=NO_WINDOW | getattr(subprocess, "DETACHED_PROCESS", 0),
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


def restart_daemon(daemon: str) -> None:
    """A synthesis that hangs leaves the daemon locked for good: kill its whole tree so the next loop starts a fresh one.
    The launcher we spawned is killed too: it survives a child-only kill and would then look alive to start_daemon."""
    global _last_spawn, _spawned
    pids = []
    if _spawned is not None and _spawned.pid:
        pids.append(_spawned.pid)
    pid = daemon_health(daemon).get("pid")
    if isinstance(pid, int) and pid > 0 and pid not in pids:
        pids.append(pid)
    for victim in pids:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(victim)], capture_output=True, timeout=15, creationflags=NO_WINDOW)
    _spawned = None
    _last_spawn = 0.0


LLM_IDLE = 300          # seconds without a text job before the LLM gives its VRAM back to Chatterbox
LLM_ARGS = "--fit on -fitt 3300 -c 4096"  # llama.cpp places the layers itself and leaves ~3.3 GB of VRAM for Chatterbox (4096 = the window HQ budgets for)
LLM_LOAD_WAIT = 90      # a cold start reads ~4.5 GB from disk
_llm = {"proc": None, "last": 0.0}


def has_llm(args) -> bool:
    return bool(getattr(args, "llm_server", None) and getattr(args, "llm_model", None))


def llm_url(args) -> str:
    return f"http://127.0.0.1:{getattr(args, 'llm_port', 8089)}"


def llm_healthy(args) -> bool:
    try:
        with urllib.request.urlopen(llm_url(args) + "/health", timeout=3) as r:
            return json.loads(r.read() or b"{}").get("status") == "ok"
    except Exception:  # noqa: BLE001 — still loading, or not running
        return False


def stop_llm() -> None:
    """Give the whole GPU back to Chatterbox. Called before every sentence and after LLM_IDLE."""
    proc = _llm["proc"]
    _llm["proc"] = None
    if proc is not None and proc.poll() is None:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=15, creationflags=NO_WINDOW)


def ensure_llm(args) -> None:
    """Start llama-server (all layers on the GPU, the 4k window the HQ side budgets for) and wait until it answers."""
    proc = _llm["proc"]
    if proc is None or proc.poll() is not None:
        _llm["proc"] = subprocess.Popen(
            [args.llm_server, "-m", args.llm_model, "-np", "1", "--host", "127.0.0.1", "--port", str(getattr(args, "llm_port", 8089)),
             *shlex.split(getattr(args, "llm_args", None) or LLM_ARGS)],
            creationflags=NO_WINDOW, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    end = time.time() + LLM_LOAD_WAIT
    while time.time() < end and not STOP.is_set():
        if _llm["proc"].poll() is not None:
            raise RuntimeError("llama-server s’est arrêté")
        if llm_healthy(args):
            return
        time.sleep(1.0)
    raise RuntimeError("llama-server trop long à démarrer")


EMBED_IDLE = 900        # seconds without an embed job before its small model is stopped (CPU only: it never holds VRAM)
EMBED_ARGS = "-ngl 0 -c 2048"
_emb = {"proc": None, "last": 0.0}


def has_embed(args) -> bool:
    """Embedding jobs need the same llama-server and an embedding .gguf (``--embed-model``)."""
    return bool(getattr(args, "llm_server", None) and getattr(args, "embed_model", None))


def embed_url(args) -> str:
    return f"http://127.0.0.1:{getattr(args, 'embed_port', 8096)}"


def stop_embed() -> None:
    proc = _emb["proc"]
    _emb["proc"] = None
    if proc is not None and proc.poll() is None:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=15, creationflags=NO_WINDOW)


def ensure_embed(args) -> None:
    """Start the embedding model on the CPU (a few hundred MB of RAM, no VRAM) and wait until it answers."""
    proc = _emb["proc"]
    if proc is None or proc.poll() is not None:
        _emb["proc"] = subprocess.Popen(
            [args.llm_server, "-m", args.embed_model, "--embedding", "-np", "1", "--host", "127.0.0.1",
             "--port", str(getattr(args, "embed_port", 8096)), *shlex.split(getattr(args, "embed_args", None) or EMBED_ARGS)],
            creationflags=NO_WINDOW, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
    end = time.time() + LLM_LOAD_WAIT
    while time.time() < end and not STOP.is_set():
        if _emb["proc"].poll() is not None:
            raise RuntimeError("le modèle d’embeddings s’est arrêté")
        try:
            with urllib.request.urlopen(embed_url(args) + "/health", timeout=3) as r:
                if json.loads(r.read() or b"{}").get("status") == "ok":
                    return
        except Exception:  # noqa: BLE001 — still loading
            pass
        time.sleep(0.5)
    raise RuntimeError("le modèle d’embeddings est trop long à démarrer")


def embed_texts(args, job: dict) -> list:
    """Vectors for a job's texts, in order. The job carries texts only."""
    texts = [str(t) for t in (job.get("texts") or [])][:64]
    if not texts:
        raise RuntimeError("aucun texte")
    ensure_embed(args)
    req = urllib.request.Request(embed_url(args) + "/v1/embeddings", json.dumps({"input": texts}).encode(),
                                 {"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read() or b"{}")
    _emb["last"] = time.time()
    rows = sorted(data.get("data") or [], key=lambda x: x.get("index", 0))
    vectors = [row.get("embedding") for row in rows]
    if len(vectors) != len(texts) or not all(isinstance(v, list) and v for v in vectors):
        raise RuntimeError("vecteurs incomplets")
    return vectors


def complete(args, job: dict) -> str:
    """One chat completion. The job carries messages, a temperature and a token cap, nothing else."""
    ensure_llm(args)
    body = {"messages": job.get("messages") or [], "temperature": job.get("temperature", 0.7),
            "max_tokens": min(int(job.get("max_tokens") or 256), 400), "stream": False}
    if job.get("json") is True:
        body["response_format"] = {"type": "json_object"}  # llama-server constrains the reply to valid JSON
    req = urllib.request.Request(llm_url(args) + "/v1/chat/completions", json.dumps(body).encode(),
                                 {"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=40) as r:
        data = json.loads(r.read() or b"{}")
    _llm["last"] = time.time()
    text = str(((data.get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
    if not text:
        raise RuntimeError("réponse vide")
    return text


def ensure_voice(creds: dict, voices: Path, name: str, stamp: int) -> bool:
    """The reference clip belongs to HQ: fetch it when the stamp changed (the daemon re-reads it by mtime)."""
    if not VOICE_RE.fullmatch(name):
        return False
    wav, mark = voices / f"{name}.wav", voices / f"{name}.stamp"
    if wav.is_file() and mark.is_file() and mark.read_text().strip() == str(stamp):
        return True
    status, data = post(creds["hq"] + f"/voice-worker/v1/voice/{name}", {}, token=creds["token"], timeout=60)
    if status != 200 or not data.get("wav_b64"):
        return False
    voices.mkdir(parents=True, exist_ok=True)
    tmp = wav.with_suffix(".tmp")
    tmp.write_bytes(base64.b64decode(data["wav_b64"]))
    os.replace(tmp, wav)
    mark.write_text(str(data.get("stamp", stamp)))
    return True


def synth(daemon: str, job: dict) -> bytes:
    body = {k: job.get(k) for k in ("text", "voice", "exaggeration", "cfg_weight", "temperature")}
    for _ in range(6):  # a busy daemon answers 429: wait a moment, then try again
        req = urllib.request.Request(daemon + "/synthesize", json.dumps(body).encode(), {"Content-Type": "application/json"},
                                     method="POST")
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code != 429:
                raise
            time.sleep(1.0)
    raise RuntimeError("daemon occupé")


def cmd_run(args) -> int:
    creds = load_creds()
    if not creds:
        print("Pas associé : lance d’abord « pair ».")
        return 1
    daemon = f"http://127.0.0.1:{args.daemon_port}"
    voices = Path(args.root) / "voices" if args.root else Path(r"C:\AI\Chatterbox\voices")
    gpu, wait = gpu_info(), 2.0
    print("Worker voix démarré. Ctrl+C pour arrêter.")
    while not STOP.is_set():
        health = daemon_health(daemon)
        if not health:
            start_daemon(args)
        info = {**gpu, "version": VERSION, "device": health.get("device"), "ready": bool(health.get("ready")),
                "llm": has_llm(args), "embed": has_embed(args)}
        if _emb["proc"] is not None and time.time() - _emb["last"] > EMBED_IDLE:
            stop_embed()
        if _llm["proc"] is not None and time.time() - _llm["last"] > LLM_IDLE:
            stop_llm()  # nobody asked for text for a while: give the RAM and VRAM back
        try:
            status, data = post(creds["hq"] + "/voice-worker/v1/poll", {"info": info}, token=creds["token"], timeout=20)
        except Exception as exc:  # noqa: BLE001 — HQ unreachable: back off, never crash
            print("HQ injoignable :", str(exc)[:80])
            time.sleep(wait)
            wait = min(30.0, wait * 2)
            continue
        if status == 401:
            print("Identifiants refusés : l’appareil a été retiré dans HQ. Refais « pair ».")
            return 1
        wait = 2.0
        job = data.get("job") if status == 200 else None
        if not job:
            if status != 200:
                time.sleep(2.0)
            continue
        started = time.time()
        try:
            if job.get("kind") == "embed":
                if not has_embed(args):
                    raise RuntimeError("pas de modèle d’embeddings")
                _emb["last"] = time.time()
                payload = {"ok": True, "vectors": embed_texts(args, job), "ms": int((time.time() - started) * 1000)}
            elif job.get("kind") == "text":
                if not has_llm(args):
                    raise RuntimeError("pas de modèle de texte")
                _llm["last"] = time.time()
                payload = {"ok": True, "text": complete(args, job), "ms": int((time.time() - started) * 1000)}
            else:
                if getattr(args, "llm_exclusive", False):
                    stop_llm()  # opt-in for a model too big to share the GPU: the sentence gets all of it
                if not health.get("ready"):
                    raise RuntimeError("Chatterbox n’est pas prêt")
                if not ensure_voice(creds, voices, job.get("voice", ""), int(job.get("voice_stamp") or 0)):
                    raise RuntimeError("voix de référence indisponible")
                try:
                    wav = synth(daemon, job)
                except (TimeoutError, urllib.error.URLError, OSError, RuntimeError):
                    restart_daemon(daemon)  # hung or stuck busy: do not leave it blocking every later line
                    raise
                payload = {"ok": True, "wav_b64": base64.b64encode(wav).decode("ascii"), "ms": int((time.time() - started) * 1000)}
        except Exception as exc:  # noqa: BLE001
            payload = {"ok": False, "error": str(exc)[:160]}
        try:
            post(creds["hq"] + f"/voice-worker/v1/result/{job['id']}", payload, token=creds["token"], timeout=60)
        except Exception as exc:  # noqa: BLE001
            print("Résultat non envoyé :", str(exc)[:80])
    return 0


def cmd_status(args) -> int:
    creds = load_creds()
    health = daemon_health(f"http://127.0.0.1:{args.daemon_port}")
    print("Associé :", creds.get("name") if creds else "non")
    print("HQ :", creds.get("hq") if creds else "-")
    print("Chatterbox :", health or "ne répond pas")
    print("GPU :", gpu_info() or "inconnu")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Musica voice worker for Transfert HQ")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pair = sub.add_parser("pair")
    pair.add_argument("--hq", required=True)
    pair.add_argument("--name", default="PC voix")
    pair.add_argument("--code-file")
    for name in ("run", "status"):
        p = sub.add_parser(name)
        p.add_argument("--daemon-port", type=int, default=8059)
        p.add_argument("--root", default=r"C:\AI\Chatterbox", help="Chatterbox folder (holds voices/)")
        p.add_argument("--daemon-python")
        p.add_argument("--daemon-script")
        p.add_argument("--llm-server", help="llama-server.exe: enables text jobs (small LLM, only while the voice is idle)")
        p.add_argument("--llm-model", help="a .gguf file for llama-server")
        p.add_argument("--llm-port", type=int, default=8089)
        p.add_argument("--embed-model", help="an embedding .gguf (CPU): enables embed jobs (needs --llm-server for the binary)")
        p.add_argument("--embed-port", type=int, default=8096)
        p.add_argument("--embed-args", help=f"extra llama-server flags for it (default: {EMBED_ARGS})")
        p.add_argument("--llm-args", help=f"extra llama-server flags (default: {LLM_ARGS})")
        p.add_argument("--llm-exclusive", action="store_true", help="stop the LLM whenever a sentence is wanted (model too big to share the GPU)")
    args = ap.parse_args()
    try:
        return {"pair": cmd_pair, "run": cmd_run, "status": cmd_status}[args.cmd](args)
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
