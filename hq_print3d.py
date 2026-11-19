"""Atelier 3D — the Master's 3D printers, their cameras, his models and MakerWorld.

One controller per bridge root (``controller(root)``). It owns:

* the printer list and their secrets in ``.hq-agent-state/print3d.json``
  (access / check codes, MakerWorld cookie) — never returned by an API;
* one live link per printer (``hq_print3d_bambu`` MQTT, ``hq_print3d_flashforge``
  HTTP poll) feeding a status cache, and a print history in ``.hq-print3d/``;
* one camera hub per printer, opened on demand and closed when nobody watches;
* the model library (``hq_print3d_models``) and MakerWorld snapshots
  (``hq_makerworld``).

Printer commands (pause / resume / stop / light) have no HTTP route of their
own: only Elsea's confirm card calls ``command()``, after the Master taps it.
This module never imports ``iphone_bridge``.
"""
from __future__ import annotations

import copy
import hashlib
import io
import ipaddress
import json
import os
import queue
import re
import secrets
import sqlite3
import shutil
import subprocess
import tempfile
import threading
import time
import zipfile
from pathlib import Path
from typing import Any, Callable

import hq_makerworld
import hq_print3d_bambu as bambu
import hq_print3d_errors as errors
import hq_print3d_filament as filament
import hq_print3d_flashforge as flashforge
import hq_print3d_models as models
import hq_print3d_projects as projects
import hq_print3d_watch as watch
import hq_state

STATE_FOLDER = ".hq-print3d"
CONFIG_FILE = "print3d.json"
HISTORY_FILE = "history.json"
MAKERWORLD_FILE = "makerworld.json"
MAX_PRINTERS = 8
MAX_HISTORY = 3000
ACTIVE_STATES = ('printing', 'preparing', 'paused')
PERIODS = {'7d': 7 * 86400, '30d': 30 * 86400, '90d': 90 * 86400, 'all': 0}
MAX_MW_HISTORY = 400
MW_INTERVAL = 6 * 3600
MW_MANUAL_MIN = 60
CAMERA_IDLE = 15.0
CAMERA_MAX_VIEWERS = 4
KINDS = ("bambu", "flashforge")
COMMANDS = ("pause", "resume", "stop", "light_on", "light_off")
_ID_RE = re.compile(r"^p-[0-9a-f]{6}$")
_SERIAL_RE = re.compile(r"^[A-Za-z0-9]{6,32}$")
_CODE_RE = re.compile(r"^[\x21-\x7e]{4,40}$")
_UA_RE = re.compile(r"^[\x20-\x7e]{10,400}$")
_COOKIE_RE = re.compile(r"^[\x20-\x7e]{10,8000}$")
_BED_DEFAULTS = (
    ("a1 mini", (180.0, 180.0, 180.0)),
    ("a1", (256.0, 256.0, 256.0)),
    ("p1p", (256.0, 256.0, 256.0)),
    ("p1s", (256.0, 256.0, 256.0)),
    ("x1", (256.0, 256.0, 256.0)),
    ("creator 5", (256.0, 256.0, 256.0)),
    ("ad5m", (220.0, 220.0, 220.0)),
    ("ad5x", (220.0, 220.0, 220.0)),
)


class Print3dError(ValueError):
    def __init__(self, message: str, status: int = 400, code: str = "validation_error") -> None:
        super().__init__(message)
        self.status = status
        self.code = code


def _private_ipv4(value: Any) -> str:
    try:
        addr = ipaddress.IPv4Address(str(value or "").strip())
    except ValueError:
        raise Print3dError("Adresse IPv4 locale requise") from None
    if not addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_unspecified:
        raise Print3dError("Adresse IPv4 privée requise")
    return str(addr)


def _default_bed(name: Any, kind: Any) -> dict[str, float] | None:
    """Known build volumes, used only until the Master enters the real plate size."""
    text = f"{name or ''} {kind or ''}".casefold()
    for needle, dims in _BED_DEFAULTS:
        if needle in text:
            return {"x": dims[0], "y": dims[1], "z": dims[2]}
    return None


def _clean_bed(value: Any) -> dict[str, float]:
    if not isinstance(value, dict):
        raise Print3dError("Plateau invalide : X, Y et Z en mm sont requis")
    out: dict[str, float] = {}
    for axis in ("x", "y", "z"):
        try:
            dim = float(value.get(axis))
        except (TypeError, ValueError):
            raise Print3dError("Plateau invalide : X, Y et Z en mm sont requis") from None
        if not (20.0 <= dim <= 2000.0):
            raise Print3dError("Plateau invalide : chaque dimension doit être entre 20 et 2000 mm")
        out[axis] = round(dim, 1)
    return out


def _bed_for_printer(printer: dict[str, Any]) -> dict[str, float] | None:
    raw = printer.get("bed")
    if isinstance(raw, dict):
        try:
            return _clean_bed(raw)
        except Print3dError:
            pass
    model = str(printer.get("model") or "").strip()
    return _default_bed(model or printer.get("name"), printer.get("kind"))


def _now() -> int:
    return int(time.time())


# ── Camera hub ─────────────────────────────────────────────────────────────

class CameraHub:
    """One upstream per printer, many viewers; closes itself when unused."""

    def __init__(self, source: Callable[[threading.Event, Callable[[bytes], None]], None]) -> None:
        self._source = source
        self._cond = threading.Condition()
        self._frame: bytes = b""
        self._seq = 0
        self._frame_at = 0.0
        self._viewers = 0
        self._touched = 0.0
        self._error = ""
        self._stop: threading.Event | None = None
        self._thread: threading.Thread | None = None

    def _on_frame(self, frame: bytes) -> None:
        with self._cond:
            self._frame = frame
            self._seq += 1
            self._frame_at = time.monotonic()
            self._error = ""
            self._cond.notify_all()

    def _run(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self._source(stop, self._on_frame)
            except Exception as exc:
                with self._cond:
                    self._error = str(exc) if isinstance(exc, (bambu.BambuError, flashforge.FlashforgeError)) \
                        else "Caméra injoignable"
                    self._cond.notify_all()
                stop.wait(3.0)
            with self._cond:
                idle = self._viewers == 0 and time.monotonic() - self._touched > CAMERA_IDLE
            if idle:
                break
            stop.wait(1.0)        # an upstream that ends at once must not spin
        with self._cond:
            if self._stop is stop:
                self._thread = None
                self._stop = None

    def _ensure(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._stop = threading.Event()
            self._thread = threading.Thread(target=self._run, args=(self._stop,), name="print3d-cam", daemon=True)
            self._thread.start()

    def acquire(self) -> None:
        with self._cond:
            if self._viewers >= CAMERA_MAX_VIEWERS:
                raise Print3dError("Trop de flux ouverts", 429, "camera_busy")
            self._viewers += 1
            self._touched = time.monotonic()
            self._ensure()

    def release(self) -> None:
        with self._cond:
            self._viewers = max(0, self._viewers - 1)
            self._touched = time.monotonic()

    def wait_frame(self, after_seq: int, timeout: float) -> tuple[int, bytes, str]:
        deadline = time.monotonic() + timeout
        with self._cond:
            self._touched = time.monotonic()
            while self._seq <= after_seq:
                left = deadline - time.monotonic()
                if left <= 0:
                    break
                self._cond.wait(min(left, 1.0))
            return self._seq, self._frame, self._error

    def snapshot(self, timeout: float = 8.0) -> bytes:
        with self._cond:
            self._touched = time.monotonic()
            self._ensure()
            fresh = self._frame and self._viewers > 0
            current = self._seq
        if fresh:
            return self._frame
        _seq, frame, err = self.wait_frame(current, timeout)   # a new frame, or the last one on timeout
        if not frame:
            raise Print3dError(err or "Caméra sans image", 504, "camera_unavailable")
        return frame

    def stop(self) -> None:
        with self._cond:
            if self._stop is not None:
                self._stop.set()
            t = self._thread
        if t is not None and t.is_alive() and t is not threading.current_thread():
            t.join(timeout=0.5)


# ── Controller ─────────────────────────────────────────────────────────────

class Controller:
    def __init__(self, root: Path, print_root: Callable[[], Path | None] | None = None) -> None:
        self.root = Path(root)
        self._print_root = print_root
        self._lock = threading.RLock()
        self._cfg_cache: tuple[tuple[int, int], dict[str, Any]] | None = None
        self._mw_cache: tuple[tuple[int, int], dict[str, Any]] | None = None
        self._hist_cache: tuple[tuple[int, int], list[dict[str, Any]]] | None = None
        self._links: dict[str, Any] = {}
        self._link_gen: dict[str, int] = {}
        self._hubs: dict[str, CameraHub] = {}
        self._status: dict[str, dict[str, Any]] = {}
        self._required: dict[str, dict[str, Any]] = {}   # job name → materials named by its sliced file
        self._link: dict[str, dict[str, Any]] = {}
        self._jobs: dict[str, dict[str, Any]] = {}
        self._kinds: dict[str, str] = {}
        self._starting: set[str] = set()
        self._staged_local = threading.local()
        try:
            self._pending_start: dict[str, dict[str, Any]] = self._load_pending_starts()
        except Print3dError:
            self._pending_start = {}
        self._tl_last: dict[str, int] = {}
        self._events: list[queue.Queue] = []
        self._mw_lock = threading.Lock()
        self._mw_running = False
        self.library = models.Library(self.state_dir(), self._model_roots)
        self.errors = errors.Catalog(self.state_dir() / "bambu_errors.json")
        self.watch = watch.Watcher(frame=self.camera_frame, pause=lambda pid: self.command(pid, "pause"),
                                   notify=self._watch_notify)

    # ── paths and config ──
    def state_dir(self) -> Path:
        d = self.root / STATE_FOLDER
        d.mkdir(parents=True, exist_ok=True)
        return d

    def _config_path(self) -> Path:
        return hq_state.agent_state_dir(self.root) / CONFIG_FILE

    def _read_config(self) -> dict[str, Any]:
        """The settings file, parsed at most once per (mtime, size).

        ``/api/print3d/state`` is polled every few seconds and used to read this file four times
        per request; the cache turns that into one stat. Every write goes through ``_write_config``,
        which drops it, so a hand-edited file is still picked up.
        """
        p = self._config_path()
        try:
            st = p.stat()
        except OSError:
            with self._lock:
                self._cfg_cache = None
            return {"printers": [], "makerworld": {}, "models_extra_root": ""}
        key = (st.st_mtime_ns, st.st_size)
        with self._lock:
            cached = self._cfg_cache
        if cached is not None and cached[0] == key:
            return copy.deepcopy(cached[1])
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception as exc:
            raise Print3dError("réglages illisibles — fichier conservé", 409, "state_unreadable") from exc
        if not isinstance(data, dict) or not isinstance(data.get("printers", []), list):
            raise Print3dError("réglages illisibles — fichier conservé", 409, "state_unreadable")
        data.setdefault("printers", [])
        data.setdefault("makerworld", {})
        data.setdefault("models_extra_root", "")
        with self._lock:
            self._cfg_cache = (key, data)
        return copy.deepcopy(data)

    def _write_config(self, data: dict[str, Any]) -> None:
        p = self._config_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        try:
            hq_state.write_json_atomic(p, data)
        except RuntimeError as exc:
            raise Print3dError(str(exc), 409, "state_unreadable") from exc
        with self._lock:
            self._cfg_cache = None

    def _model_roots(self) -> dict[str, Path | None]:
        out: dict[str, Path | None] = {}
        try:
            out["print"] = self._print_root() if self._print_root else None
        except Exception:
            out["print"] = None
        try:
            extra = str(self._read_config().get("models_extra_root") or "")
        except Print3dError:
            extra = ""
        out["extra"] = Path(extra) if extra else None
        return out

    def public_config(self) -> dict[str, Any]:
        cfg = self._read_config()
        mw = cfg.get("makerworld") or {}
        return {
            "printers": [{"id": p.get("id"), "name": p.get("name"), "kind": p.get("kind"),
                          "model": p.get("model") or "",
                          "capabilities": models.printer_capabilities(p.get("model") or ""),
                          "ip": p.get("ip"), "serial": p.get("serial"), "bed": _bed_for_printer(p),
                          "has_code": bool(p.get("code"))} for p in cfg["printers"] if isinstance(p, dict)],
            "printer_catalog": models.printer_catalog(),
            "makerworld": {"handle": mw.get("handle") or "", "uid": int(mw.get("uid") or 0),
                           "has_cookie": bool(mw.get("cookie")), "has_ua": bool(mw.get("ua"))},
            "models_extra_root": cfg.get("models_extra_root") or "",
            "filament": filament.clean_settings(None, cfg.get("filament")),
            "watch": {**watch.clean_settings(None, cfg.get("watch")), "checks_today": self.watch.checks_today(),
                      "max_per_day": watch.MAX_CHECKS_PER_DAY},
            "mw_alerts": hq_makerworld.clean_alert_settings(None, cfg.get("mw_alerts")),
        }

    def filament_settings(self) -> dict[str, Any]:
        try:
            return filament.clean_settings(None, self._read_config().get("filament"))
        except Print3dError:
            return filament.clean_settings(None, None)

    def _printer_cfg(self, printer_id: str) -> dict[str, Any]:
        for p in self._read_config()["printers"]:
            if isinstance(p, dict) and p.get("id") == printer_id:
                return dict(p)
        raise Print3dError("Imprimante inconnue", 404, "not_found")

    # ── settings (write-only secrets) ──
    def save_printer(self, data: dict[str, Any]) -> dict[str, Any]:
        name = str(data.get("name") or "").strip()[:40]
        kind = str(data.get("kind") or "")
        if not name:
            raise Print3dError("Nom requis")
        if kind not in KINDS:
            raise Print3dError("Type d'imprimante inconnu")
        ip = _private_ipv4(data.get("ip"))
        serial = str(data.get("serial") or "").strip()
        if serial and not _SERIAL_RE.fullmatch(serial):
            raise Print3dError("Numéro de série invalide")
        if kind == "bambu" and not serial:
            raise Print3dError("Numéro de série requis pour une Bambu")
        code_in = data.get("code")
        with self._lock:
            cfg = self._read_config()
            printers = [p for p in cfg["printers"] if isinstance(p, dict)]
            pid = str(data.get("id") or "")
            existing = next((p for p in printers if p.get("id") == pid), None) if pid else None
            if pid and existing is None:
                raise Print3dError("Imprimante inconnue", 404, "not_found")
            if existing is None and len(printers) >= MAX_PRINTERS:
                raise Print3dError("Trop d'imprimantes")
            if any(p.get("ip") == ip and p is not existing for p in printers):
                raise Print3dError("Une autre imprimante utilise déjà cette adresse", 409, "duplicate")
            code = existing.get("code", "") if existing else ""
            if isinstance(code_in, str) and code_in.strip():
                if not _CODE_RE.fullmatch(code_in.strip()):
                    raise Print3dError("Code d'accès invalide")
                code = code_in.strip()
            if kind == "bambu" and not code:
                raise Print3dError("Code d'accès requis pour une Bambu")
            bed = _bed_for_printer(existing) if existing else None
            if isinstance(data.get("bed"), dict):
                bed = _clean_bed(data["bed"])
            row = {"id": pid or "p-" + secrets.token_hex(3), "name": name, "kind": kind,
                   "ip": ip, "serial": serial, "code": code, "bed": bed}
            req_model = str(data.get("model") or "").strip()
            family_models = models.FAMILY_MODELS
            if req_model:
                if req_model not in models.CANONICAL_PROFILES:
                    raise Print3dError(f"Modèle d'imprimante inconnu ({req_model})")
                if req_model not in family_models.get(kind, ()):
                    raise Print3dError(f"Modèle {req_model} incompatible avec le type {kind}")
                row["model"] = req_model
                if existing and existing.get("model") != req_model and not isinstance(data.get("bed"), dict):
                    row["bed"] = _default_bed(req_model, kind)
                elif existing is None and not isinstance(data.get("bed"), dict):
                    row["bed"] = _default_bed(req_model, kind)
            elif existing and existing.get("model") and existing["model"] in family_models.get(kind, ()):
                row["model"] = existing["model"]
            else:
                for cand in ("A1 mini", "Creator 5", "AD5M", "AD5X", "P1S", "X1C", "A1"):
                    if cand in family_models.get(kind, ()) and cand.lower() in name.lower():
                        row["model"] = cand
                        break
            eff_model = str(row.get("model") or "").strip()
            if isinstance(data.get("bed"), dict) and eff_model in models.CANONICAL_PROFILES:
                cbx, cby, cbz = models.CANONICAL_PROFILES[eff_model]["bed"]
                if bed and (bed["x"] > cbx + 1e-6 or bed["y"] > cby + 1e-6 or bed["z"] > cbz + 1e-6):
                    raise Print3dError(
                        f"Dimensions plateau ({bed['x']:g}×{bed['y']:g}×{bed['z']:g} mm) dépassent le volume physique de {eff_model} ({cbx:g}×{cby:g}×{cbz:g} mm)",
                        422, "out_of_bounds",
                    )
            if existing and existing.get("tls_fp") and existing.get("ip") == ip and existing.get("serial") == serial:
                row["tls_fp"] = existing["tls_fp"]
            if existing is None:
                printers.append(row)
            else:
                printers[printers.index(existing)] = row
            cfg["printers"] = printers
            self._write_config(cfg)
            self._restart_link(row["id"])
        return self.public_config()

    def delete_printer(self, printer_id: str) -> dict[str, Any]:
        with self._lock:
            cfg = self._read_config()
            before = len(cfg["printers"])
            cfg["printers"] = [p for p in cfg["printers"] if not (isinstance(p, dict) and p.get("id") == printer_id)]
            if len(cfg["printers"]) == before:
                raise Print3dError("Imprimante inconnue", 404, "not_found")
            self._write_config(cfg)
            self._stop_link(printer_id)
            self._status.pop(printer_id, None)
            self._link.pop(printer_id, None)
        return self.public_config()

    def save_settings(self, data: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            cfg = self._read_config()
            mw = dict(cfg.get("makerworld") or {})
            if "handle" in data:
                handle = str(data.get("handle") or "").strip().lstrip("@")
                if handle and not hq_makerworld.HANDLE_RE.fullmatch(handle):
                    raise Print3dError("Pseudo MakerWorld invalide")
                mw["handle"] = handle
            if "uid" in data:
                try:
                    mw["uid"] = max(0, int(data.get("uid") or 0))
                except (TypeError, ValueError):
                    raise Print3dError("uid invalide") from None
            for key, rx in (("cookie", _COOKIE_RE), ("ua", _UA_RE)):
                val = data.get(key)
                if isinstance(val, str) and val.strip():
                    if not rx.fullmatch(val.strip()):
                        raise Print3dError("Valeur invalide : " + key)
                    mw[key] = val.strip()
                if data.get("clear_" + key) is True:
                    mw.pop(key, None)
            cfg["makerworld"] = mw
            if "filament" in data:
                try:
                    cfg["filament"] = filament.clean_settings(data["filament"], cfg.get("filament"))
                except filament.FilamentError as exc:
                    raise Print3dError(str(exc)) from None
            if isinstance(data.get("mw_alerts"), dict):
                cfg["mw_alerts"] = hq_makerworld.clean_alert_settings(data["mw_alerts"], cfg.get("mw_alerts"))
            if isinstance(data.get("watch"), dict):
                cfg["watch"] = watch.clean_settings(data["watch"], cfg.get("watch"))
            if "models_extra_root" in data:
                raw = str(data.get("models_extra_root") or "").strip()
                if raw:
                    p = Path(raw)
                    if not p.is_absolute() or not p.is_dir() or models._is_link(p):
                        raise Print3dError("Dossier introuvable ou lien refusé")
                    raw = str(p.resolve())
                cfg["models_extra_root"] = raw
            self._write_config(cfg)
        self.library.scan(force=True)
        return self.public_config()

    def _pending_path(self) -> Path:
        return self.state_dir() / "pending_starts.json"

    def _pending_db_conn(self) -> sqlite3.Connection:
        db_path = self.state_dir() / "pending_starts.db"
        conn = sqlite3.connect(str(db_path), timeout=5.0, isolation_level=None)
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("CREATE TABLE IF NOT EXISTS pending_starts (printer_id TEXT PRIMARY KEY, payload TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS queue_claims (item_id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at REAL NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS queue_items (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, payload TEXT NOT NULL)")
        conn.execute("CREATE TABLE IF NOT EXISTS queue_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        return conn

    def _load_pending_starts(self) -> dict[str, dict[str, Any]]:
        p = self._pending_path()
        out: dict[str, dict[str, Any]] = {}
        if p.exists():
            try:
                raw = p.read_text(encoding="utf-8")
                data = json.loads(raw)
            except (OSError, ValueError) as exc:
                raise Print3dError("Réservations de départ illisibles", 409, "state_unreadable") from exc
            if not isinstance(data, dict) or not all(isinstance(v, dict) for v in data.values()):
                raise Print3dError("Schéma de réservations invalide", 409, "state_unreadable")
            out = {str(k): dict(v) for k, v in data.items()}
        db_path = self.state_dir() / "pending_starts.db"
        if db_path.exists():
            try:
                conn = self._pending_db_conn()
                try:
                    for pid, pl in conn.execute("SELECT printer_id, payload FROM pending_starts"):
                        if pid not in out:
                            out[str(pid)] = json.loads(pl)
                finally:
                    conn.close()
            except (sqlite3.Error, ValueError) as exc:
                raise Print3dError("Base de réservations illisible", 409, "state_unreadable") from exc
        return out

    def _claim_pending_start(self, printer_id: str, entry: dict[str, Any]) -> None:
        with self._lock, hq_state.path_lock(self._pending_path()):
            conn = self._pending_db_conn()
            try:
                conn.execute("BEGIN IMMEDIATE")
                row = conn.execute("SELECT 1 FROM pending_starts WHERE printer_id=?", (printer_id,)).fetchone()
                cur = self._load_pending_starts()
                if row is not None or printer_id in cur or printer_id in self._pending_start:
                    conn.execute("ROLLBACK")
                    raise Print3dError("Démarrage déjà en cours sur cette imprimante", 409, "printer_busy")
                cur[printer_id] = dict(entry)
                self._pending_start[printer_id] = dict(entry)
                conn.execute("INSERT INTO pending_starts (printer_id, payload) VALUES (?, ?)",
                             (printer_id, json.dumps(entry)))
                try:
                    hq_state.write_json_atomic(self._pending_path(), cur, verify_existing=True)
                except (OSError, RuntimeError) as exc:
                    conn.execute("ROLLBACK")
                    raise Print3dError("Réservation de départ non durable — envoi interdit", 503, "state_unwritable") from exc
                conn.execute("COMMIT")
            except sqlite3.Error as exc:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise Print3dError("Verrouillage de réservation impossible", 503, "state_unwritable") from exc
            finally:
                conn.close()

    def _mark_pending_ambiguous(self, printer_id: str) -> None:
        with self._lock, hq_state.path_lock(self._pending_path()):
            if printer_id in self._pending_start:
                self._pending_start[printer_id]["ambiguous"] = True
            try:
                conn = self._pending_db_conn()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    cur = self._load_pending_starts()
                    if printer_id in cur:
                        cur[printer_id]["ambiguous"] = True
                        conn.execute("UPDATE pending_starts SET payload=? WHERE printer_id=?",
                                     (json.dumps(cur[printer_id]), printer_id))
                        hq_state.write_json_atomic(self._pending_path(), cur, verify_existing=True)
                    conn.execute("COMMIT")
                finally:
                    conn.close()
            except (OSError, RuntimeError, Print3dError, sqlite3.Error):
                pass

    def _release_pending_start(self, printer_id: str) -> None:
        with self._lock, hq_state.path_lock(self._pending_path()):
            self._pending_start.pop(printer_id, None)
            try:
                conn = self._pending_db_conn()
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    conn.execute("DELETE FROM pending_starts WHERE printer_id=?", (printer_id,))
                    cur = self._load_pending_starts()
                    if printer_id in cur:
                        cur.pop(printer_id, None)
                        hq_state.write_json_atomic(self._pending_path(), cur, verify_existing=True)
                    conn.execute("COMMIT")
                finally:
                    conn.close()
            except (OSError, RuntimeError, Print3dError, sqlite3.Error):
                pass

    # ── live links ──
    def _on_status(self, printer_id: str, status: dict[str, Any], gen: int | None = None) -> None:
        """Cache the status and follow the job: start, progress, estimate, end. Cheap and non-blocking."""
        resolve = finished = None
        with self._lock:
            if gen is not None and gen != self._link_gen.get(printer_id):
                return
            status = dict(status)
            status["updated"] = _now()
            # The list belongs to one job only: once that job ends (or the printer idles), drop it,
            # so a later job reusing the same file name cannot inherit a stale "wanted" list.
            if status.get("state") in ("finished", "failed", "idle"):
                self._required.pop(printer_id, None)
            # A printer report carries no "wanted" material: attach the sliced file's list while it
            # still describes this job, so a missing spool can be named without guessing.
            req = self._required.get(printer_id)
            if req and req.get("job") and status.get("job") == req["job"]:
                status["required"] = dict(req)
            self._status[printer_id] = status
            state = status.get("state")
            pend = self._pending_start.get(printer_id)
            if pend is not None and state in ("printing", "paused", "finished", "failed"):
                job_name = str(status.get("job") or "").strip()
                want_job = str(pend.get("job") or "").strip()
                if want_job and job_name and (
                    job_name.lower() == want_job.lower()
                    or models.Library._job_stem(job_name).lower() == want_job.lower()
                ):
                    self._release_pending_start(printer_id)
            job = self._jobs.get(printer_id)
            if state in ACTIVE_STATES:
                if job is None:
                    job = self._jobs[printer_id] = {
                        "start": _now(), "name": "", "max_progress": 0.0, "estimate": None, "tried": False,
                        "printed": False, "ams_start": {}, "ams_last": {}, "materials": [],
                        "counter_start": status.get("counter_m"), "counter_last": status.get("counter_m"),
                        "layers": None, "error_codes": [], "required_tried": False}
                self._track(job, status)
                # Both machines run files from the Print library: the sliced file names the materials
                # the part needs, once, even though neither status carries that list.
                want_est = (job["estimate"] is None and not job["tried"] and job["name"]
                            and self._kinds.get(printer_id) == "bambu")
                want_req = bool(job["name"] and not job["required_tried"])
                if want_est or want_req:
                    job["required_tried"] = True
                    if want_est:
                        job["tried"] = True
                    resolve = (printer_id, job["name"], int(status.get("plate") or 1))
            elif job is not None and state in ("finished", "failed", "idle"):
                self._track(job, status)
                self._jobs.pop(printer_id, None)
                finished = (job, status, "finished" if state == "finished" else
                            ("failed" if state == "failed" else "stopped"))
        if resolve:
            threading.Thread(target=self._resolve_slice, args=resolve, name="print3d-slice",
                             daemon=True).start()
        if finished and finished[0]["printed"]:
            self._record_job(printer_id, *finished)
        self._notify_events()

    def subscribe_events(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(maxsize=16)
        evicted: queue.Queue | None = None
        with self._lock:
            if len(self._events) >= 8:
                evicted = self._events.pop(0)
            self._events.append(q)
        if evicted is not None:
            while not evicted.empty():
                try:
                    evicted.get_nowait()
                except queue.Empty:
                    break
            try:
                evicted.put_nowait(None)
            except queue.Full:
                pass
        return q

    def unsubscribe_events(self, q: queue.Queue) -> None:
        with self._lock:
            self._events = [x for x in self._events if x is not q]

    def _notify_events(self) -> None:
        with self._lock:
            listeners = list(self._events)
        for q in listeners:
            try:
                q.put_nowait(1)
            except queue.Full:
                pass

    @staticmethod
    def _track(job: dict[str, Any], status: dict[str, Any]) -> None:
        if status.get("job") and not job["name"]:
            job["name"] = str(status["job"])
        progress = status.get("progress")
        if isinstance(progress, (int, float)) and progress > job["max_progress"]:
            job["max_progress"] = float(progress)
        if isinstance(status.get("total_layers"), (int, float)) and status["total_layers"]:
            job["layers"] = status["total_layers"]
        if status.get("state") in ("printing", "paused"):
            job["printed"] = True
        est = filament.estimate_from_printer(status)
        if est and (job["estimate"] is None or job["estimate"]["source"] == "printer"):
            job["estimate"] = est
        snap = filament.ams_snapshot(status.get("ams"))
        if snap:
            job["ams_start"] = job["ams_start"] or snap
            job["ams_last"] = snap
        if status.get("materials"):
            job["materials"] = list(status["materials"])
        codes = ([status["error_ecode"]] if status.get("error_ecode") else []) + list(status.get("hms") or [])
        if codes:
            job["error_codes"] = codes[:errors.MAX_PROBLEMS]
        if isinstance(status.get("counter_m"), (int, float)):
            job["counter_start"] = job["counter_start"] if isinstance(job["counter_start"], (int, float)) else status["counter_m"]
            job["counter_last"] = status["counter_m"]
        now = _now()
        curve = job.setdefault("curve", [])
        if not curve or now - curve[-1]["t"] >= 20:
            if len(curve) < 90:
                curve.append({
                    "t": now,
                    "nozzle": round(status["nozzle"], 1) if isinstance(status.get("nozzle"), (int, float)) else None,
                    "bed": round(status["bed"], 1) if isinstance(status.get("bed"), (int, float)) else None,
                    "pct": round(status["progress"], 1) if isinstance(status.get("progress"), (int, float)) else None,
                })

    def _resolve_slice(self, printer_id: str, name: str, plate: int) -> None:
        """Find the sliced file of the running job: the Print library first, then the 3MF the Bambu
        itself kept. Its filament types feed the estimate (Bambu) and the missing-material check
        (both kinds). Runs off the link thread; any failure just means 'no slice data'."""
        kind = self._kinds.get(printer_id)
        fil: list[dict[str, Any]] = []
        est = None
        try:
            model_id = self.library.find_slice_file(name)
            if model_id:
                fil = self.library.inspect_print_file(model_id, plate).get("filaments") or []
                est = filament.estimate_from_slice(fil)
            if est is None and kind == "bambu":
                cfg = self._printer_cfg(printer_id)
                raw = bambu.fetch_file(cfg["ip"], cfg.get("code", ""), [f"{name}.gcode.3mf", f"{name}.3mf"])
                with zipfile.ZipFile(io.BytesIO(raw)) as zf:
                    fil = models.read_slice_info(zf, plate).get("filaments") or []
                    est = filament.estimate_from_slice(fil)
        except Exception:
            fil, est = [], None
        # A G-code header names its materials without grams: the alert still has what it needs.
        mats = sorted({filament.base_material(f.get("type")) for f in fil if str(f.get("type") or "").strip()})
        if not mats and not est:
            return
        with self._lock:
            job = self._jobs.get(printer_id)
            if job is None or job["name"] != name:
                return
            if kind == "bambu" and est and job["estimate"] is None:
                job["estimate"] = est
            if mats:
                self._required[printer_id] = {"job": name, "materials": mats[:8]}
                cur = self._status.get(printer_id)
                if cur is not None and cur.get("job") == name:
                    cur["required"] = dict(self._required[printer_id])

    def _on_link(self, printer_id: str, ok: bool, error: str, gen: int | None = None) -> None:
        with self._lock:
            if gen is not None and gen != self._link_gen.get(printer_id):
                return
            if not ok:
                self._status.pop(printer_id, None)
                self._required.pop(printer_id, None)
            prev = self._link.get(printer_id) or {}
            # ``at`` is the last attempt (the link retries every 3-60 s), so it cannot say how long an
            # outage has lasted. ``since`` is when the current one began, kept across attempts.
            if ok:
                since = 0
            elif prev.get("online") is False and prev.get("since"):
                since = prev["since"]
            else:
                since = _now()
            self._link[printer_id] = {"online": ok, "error": "" if ok else error[:120],
                                      "at": _now(), "since": since}
        self._notify_events()

    # ── job history ──
    def _history_path(self) -> Path:
        return self.state_dir() / HISTORY_FILE

    def _read_jobs(self) -> list[dict[str, Any]]:
        """Parsed once per file version: every poll reads 10 rows out of a file that only grows."""
        path = self._history_path()
        try:
            st = path.stat()
        except OSError:
            return []
        key = (st.st_mtime_ns, st.st_size)
        if self._hist_cache and self._hist_cache[0] == key:
            return list(self._hist_cache[1])      # outer copy only: callers append, the cache never grows
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            jobs = data.get("jobs") if isinstance(data, dict) else None
        except Exception:
            raise Print3dError("historique illisible — fichier conservé", 409, "state_unreadable") from None
        if not isinstance(jobs, list):
            raise Print3dError("historique illisible — fichier conservé", 409, "state_unreadable")
        self._hist_cache = (key, jobs)
        return list(jobs)

    def _write_jobs(self, jobs: list[dict[str, Any]]) -> None:
        try:
            hq_state.write_json_atomic(self._history_path(), {"jobs": jobs[-MAX_HISTORY:]})
            self._hist_cache = None               # the file moved: re-parse on the next read
        except RuntimeError as exc:
            raise Print3dError(str(exc), 409, "state_unreadable") from exc

    def _record_job(self, printer_id: str, job: dict[str, Any], status: dict[str, Any], outcome: str) -> None:
        try:
            name = self._printer_cfg(printer_id).get("name", printer_id)
        except Print3dError:
            name = printer_id
        settings = self.filament_settings()
        layers, last = job["layers"], status.get("layer")
        if outcome == "stopped" and (job["max_progress"] >= 97 or (
                isinstance(layers, (int, float)) and layers and isinstance(last, (int, float)) and last >= layers)):
            outcome = "finished"                # it ran to the end; the printer just went straight to idle
        fraction = 1.0 if outcome == "finished" else job["max_progress"] / 100.0
        # Last resort (the Creator 5 reports no estimate): its running filament counter, taken as metres.
        # The unit is not documented: it moves live with extrusion and ~1.2 after two layers of a large flat
        # part fits metres (not grams), but it is labelled "to confirm" until a weighed print agrees.
        fil = filament.compute(job["estimate"], fraction, ams_start=job["ams_start"], ams_end=job["ams_last"],
                               spool_g=settings["spool_g"], counter_start=job["counter_start"],
                               counter_end=job["counter_last"], materials=job["materials"])
        c0, c1 = job["counter_start"], job["counter_last"]
        counter_delta = round(c1 - c0, 3) if isinstance(c0, (int, float)) and isinstance(c1, (int, float)) else None
        job_id = secrets.token_hex(4)
        tl_name = self._finish_timelapse(printer_id, job_id)
        row = {"id": job_id, "at": _now(), "printer": printer_id, "printer_name": name,
               "job": job["name"] or status.get("job") or "", "outcome": outcome,
               "duration_sec": _now() - job["start"], "layers": job["layers"],
               "progress": round(job["max_progress"], 1), "filament": fil, "counter_delta": counter_delta,
               "problems": self._problems_for_job(printer_id, job, status, outcome),
               "curve": (job.get("curve") or [])[-90:],
               "timelapse": tl_name}
        if fil and isinstance(fil.get("by_material"), dict):
            for mat, v in fil["by_material"].items():
                try:
                    filament.consume_spool(self.state_dir(), mat, "", float(v.get("g") or 0))
                except Exception:
                    pass
        with hq_state.path_lock(self._history_path()):
            try:
                jobs = self._read_jobs()
            except Print3dError:
                return                          # unreadable: preserved, not overwritten
            jobs.append(row)
            try:
                self._write_jobs(jobs)
            except Print3dError:
                return

    def _problems_for_job(self, printer_id: str, job: dict[str, Any], status: dict[str, Any], outcome: str) -> list[dict[str, Any]]:
        """Why a job did not end well: the codes seen while it ran, spelled out when it failed or stopped."""
        if outcome == "finished":
            return []
        kind = self._kinds.get(printer_id, "")
        if kind == "flashforge":
            return errors.flashforge_problem(status.get("error_code"))
        return self.errors.explain(job.get("error_codes") or [])

    def _decorated(self, job: dict[str, Any], settings: dict[str, Any]) -> dict[str, Any]:
        row = dict(job)
        fil = row.get("filament")
        if isinstance(fil, dict):
            row["filament"] = {**fil, "cost": filament.job_cost(fil, settings)}
        return row

    def history(self, limit: int = 30, settings: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        settings = settings or self.filament_settings()
        jobs = self._read_jobs()[-max(1, min(MAX_HISTORY, int(limit))):]
        return [self._decorated(j, settings) for j in reversed(jobs) if isinstance(j, dict)]

    def edit_job(self, job_id: str, data: dict[str, Any]) -> dict[str, Any]:
        """Type your own grams over an estimate (e.g. after weighing the part)."""
        with hq_state.path_lock(self._history_path()):
            jobs = [dict(j) for j in self._read_jobs()]   # the cached rows are shared: never edit them in place
            job = next((j for j in jobs if isinstance(j, dict) and j.get("id") == job_id), None)
            if job is None:
                raise Print3dError("Impression inconnue", 404, "not_found")
            try:
                job["filament"] = filament.with_manual_grams(job.get("filament"), float(data.get("grams")))
            except (TypeError, ValueError, filament.FilamentError):
                raise Print3dError("Poids invalide (0 – 20 000 g)") from None
            self._write_jobs(jobs)
        return self._decorated(job, self.filament_settings())

    def delete_job(self, job_id: str) -> dict[str, Any]:
        with hq_state.path_lock(self._history_path()):
            jobs = self._read_jobs()
            kept = [j for j in jobs if not (isinstance(j, dict) and j.get("id") == job_id)]
            if len(kept) == len(jobs):
                raise Print3dError("Impression inconnue", 404, "not_found")
            self._write_jobs(kept)
        return {"ok": True}

    def filament_stats(self, period: str = "30d") -> dict[str, Any]:
        if period not in PERIODS:
            raise Print3dError("Période inconnue")
        settings = self.filament_settings()
        jobs = [j for j in self._read_jobs() if isinstance(j, dict)]
        since = _now() - PERIODS[period] if PERIODS[period] else 0
        out = filament.summarize(jobs, settings, since=since, now=_now())
        out.update({"ok": True, "period": period, "settings": settings,
                    "recent": [self._decorated(j, settings) for j in reversed(jobs[-12:])]})
        return out

    def _pin_tls_fp(self, printer_id: str, fp: str) -> None:
        if not fp:
            return
        with self._lock, hq_state.path_lock(self._config_path()):
            cfg = self._read_config()
            for row in cfg.get("printers") or []:
                if isinstance(row, dict) and row.get("id") == printer_id and not row.get("tls_fp"):
                    row["tls_fp"] = fp
                    self._write_config(cfg)
                    break

    def _make_link(self, p: dict[str, Any], gen: int = 0) -> Any:
        pid = p["id"]
        on_status = lambda s, pid=pid, g=gen: self._on_status(pid, s, g)  # noqa: E731
        on_link = lambda ok, err, pid=pid, g=gen: self._on_link(pid, ok, err, g)  # noqa: E731
        if p.get("kind") == "bambu":
            return bambu.BambuLink(
                p["ip"], p.get("serial", ""), p.get("code", ""), on_status, on_link,
                tls_fp=str(p.get("tls_fp") or ""),
                on_pin=lambda fp, pid=pid: self._pin_tls_fp(pid, fp),
            )
        return flashforge.FlashforgeLink(p["ip"], p.get("serial", ""), p.get("code", ""), on_status, on_link)

    def _make_hub(self, p: dict[str, Any], link: Any) -> CameraHub:
        if p.get("kind") == "bambu":
            ip, code = p["ip"], p.get("code", "")
            pid = p["id"]
            def _bambu_cam(stop: threading.Event, cb: Callable[[bytes], None]) -> None:
                try:
                    fp = str(self._printer_cfg(pid).get("tls_fp") or "")
                except Print3dError:
                    fp = ""
                bambu.camera_frames(ip, code, stop, cb, tls_fp=fp, on_pin=lambda new_fp: self._pin_tls_fp(pid, new_fp))
            return CameraHub(_bambu_cam)
        ip = p["ip"]
        return CameraHub(lambda stop, cb: flashforge.camera_frames(ip, getattr(link, "camera_path", "/?action=stream"),
                                                                   stop, cb))

    def _stop_link(self, printer_id: str) -> None:
        self._link_gen[printer_id] = self._link_gen.get(printer_id, 0) + 1
        link = self._links.pop(printer_id, None)
        if link is not None:
            link.stop()
        hub = self._hubs.pop(printer_id, None)
        if hub is not None:
            hub.stop()

    def _restart_link(self, printer_id: str) -> None:
        with self._lock:
            self._stop_link(printer_id)
            self._status.pop(printer_id, None)
            self._required.pop(printer_id, None)
            gen = self._link_gen[printer_id]
            p = self._printer_cfg(printer_id)
            link = self._make_link(p, gen)
            self._links[printer_id] = link
            self._kinds[printer_id] = p.get("kind", "")
            self._hubs[printer_id] = self._make_hub(p, link)
            self._link[printer_id] = {"online": False, "error": "Connexion…", "at": _now(), "since": _now()}
            link.start()

    def ensure_links(self) -> None:
        """Start missing links and restart dead ones. Never raises."""
        try:
            printers = [p for p in self._read_config()["printers"] if isinstance(p, dict)]
        except Exception:
            return
        for p in printers:
            link = self._links.get(p.get("id"))
            if link is None or not link.alive():
                try:
                    self._restart_link(p["id"])
                except Exception:
                    continue

    def shutdown(self) -> None:
        with self._lock:
            for pid in list(self._links):
                self._stop_link(pid)

    # ── reads ──
    def printers(self) -> list[dict[str, Any]]:
        return self._printers_from(self.public_config())

    def _printers_from(self, cfg: dict[str, Any]) -> list[dict[str, Any]]:
        self.ensure_links()
        with self._lock:
            status_snap = {k: dict(v) for k, v in self._status.items()}
            link_snap = {k: dict(v) for k, v in self._link.items()}
        out = []
        for p in cfg["printers"]:
            pid = p["id"]
            row = dict(p)
            row["status"] = dict(status_snap.get(pid) or {"state": "unknown"})
            row["status"]["problems"] = self.problems(p.get("kind", ""), row["status"])
            row["status"]["watch"] = self.watch.public(pid)
            row["link"] = dict(link_snap.get(pid) or {"online": False, "error": "", "at": 0, "since": 0})
            job = str(row["status"].get("job") or "")
            row["plate"] = self._plate_for_job(job) if job else None
            if row["plate"] and row["status"].get("state") in ACTIVE_STATES and row["plate"].get("ext") == "3mf":
                try:
                    pnum = int(row["status"].get("plate") or 1)
                    row["plate_objects"] = self.library.inspect_print_file(row["plate"]["id"], pnum).get("objects") or []
                except Exception:
                    row["plate_objects"] = []
            out.append(row)
        return out

    def _plate_for_job(self, name: str) -> dict[str, Any] | None:
        """The library file behind the running job, for the card's plate preview.

        The library scan is cached (``SCAN_TTL``), so a poll does not walk Print every time.
        Only the display fields leave this function: notes and the rest of the metadata stay
        server-side.
        """
        try:
            model_id = self.library.find_by_job_name(name)
            if not model_id:
                return None
            row = next((m for m in self.library.scan() if m.get("id") == model_id), None)
        except Exception:
            return None
        if not row:
            return None
        return {"id": row["id"], "name": row["name"], "ext": row["ext"],
                "has_thumb": row.get("ext") == "3mf"}

    def problems(self, kind: str, status: dict[str, Any]) -> list[dict[str, Any]]:
        """What the printer is complaining about, in words (see ``hq_print3d_errors``)."""
        if kind == "bambu":
            codes = list(status.get("hms") or [])
            if status.get("error_ecode"):
                codes.insert(0, str(status["error_ecode"]))
            if codes and self.errors.needs_refresh():
                self.errors.ensure_async()       # first problem seen: fetch Bambu's description table once
            return self.errors.explain(codes)
        if kind == "flashforge":
            return errors.flashforge_problem(status.get("error_code"))
        return []

    def printer(self, printer_id: str) -> dict[str, Any]:
        for row in self.printers():
            if row["id"] == printer_id:
                return row
        raise Print3dError("Imprimante inconnue", 404, "not_found")

    def find_printer(self, ref: str) -> dict[str, Any]:
        """By id, or by a case-insensitive name fragment (for Elsea)."""
        ref = str(ref or "").strip().lower()
        rows = self.printers()
        for row in rows:
            if row["id"] == ref:
                return row
        hits = [r for r in rows if ref and ref in str(r["name"]).lower()]
        if len(hits) == 1:
            return hits[0]
        if not hits:
            raise Print3dError("Imprimante inconnue", 404, "not_found")
        raise Print3dError("Nom ambigu : précise l'imprimante", 409, "ambiguous")

    def command(self, printer_id: str, name: str) -> dict[str, Any]:
        if name not in COMMANDS:
            raise Print3dError("Commande inconnue")
        self.printer(printer_id)
        link = self._links.get(printer_id)
        if link is None:
            raise Print3dError("Imprimante hors ligne", 503, "printer_offline")
        try:
            link.command(name)
        except (bambu.BambuError, flashforge.FlashforgeError) as exc:
            raise Print3dError(str(exc), 502, "printer_error") from None
        if name == "stop":
            self._release_pending_start(printer_id)
        return {"ok": True, "printer": printer_id, "command": name}

    def direct_command(self, printer_id: str, action: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        """Direct Focus Room control (speed, temps, fans, skip_objects, AMS, pause/light)."""
        p = self.printer(printer_id)
        link = self._links.get(printer_id)
        if link is None:
            raise Print3dError("Imprimante hors ligne", 503, "printer_offline")
        try:
            if p["kind"] == "bambu":
                link.control(action, params)
            else:
                if action not in COMMANDS:
                    raise Print3dError("Commande non prise en charge sur Flashforge", 422, "unsupported")
                link.command(action)
        except (bambu.BambuError, flashforge.FlashforgeError) as exc:
            raise Print3dError(str(exc), 502, "printer_error") from None
        if action == "stop":
            self._release_pending_start(printer_id)
        return {"ok": True, "printer": printer_id, "action": action}

    def list_sd_files(self, printer_id: str) -> list[dict[str, Any]]:
        p = self.printer(printer_id)
        if p["kind"] != "bambu":
            raise Print3dError("Liste SD disponible uniquement sur Bambu Lab", 422, "unsupported")
        cfg = self._printer_cfg(printer_id)
        try:
            return bambu.list_sd_files(cfg["ip"], cfg.get("code", ""))
        except bambu.BambuError as exc:
            raise Print3dError(str(exc), 502, "printer_error") from None

    def _assert_printer_ready(self, printer: dict[str, Any]) -> None:
        with self._lock, hq_state.path_lock(self._pending_path()):
            disk_pending = self._load_pending_starts()
            if printer["id"] in self._pending_start or printer["id"] in disk_pending:
                raise Print3dError(f"Démarrage déjà en cours sur {printer['name']}", 409, "printer_busy")
        status = printer.get("status") or {}
        state = status.get("state")
        if not (printer.get("link") or {}).get("online"):
            raise Print3dError(f"{printer['name']} est hors ligne", 503, "printer_offline")
        if state != "idle":
            raise Print3dError(f"{printer['name']} n'est pas libre ({state})", 409, "printer_busy")
        updated = int(status.get("updated") or 0)
        if not updated or (_now() - updated) > 60:
            raise Print3dError(f"État de {printer['name']} trop ancien — réessaye après actualisation",
                               503, "stale_status")

    def start_sd_print(self, printer_id: str, filename: str, plate: int = 1,
                       options: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            if printer_id in self._starting:
                raise Print3dError("Un envoi est déjà en cours sur cette imprimante", 409, "printer_busy")
            self._starting.add(printer_id)
        try:
            p = self.printer(printer_id)
            if p["kind"] != "bambu":
                raise Print3dError("Lancement SD disponible uniquement sur Bambu Lab", 422, "unsupported")
            self._assert_printer_ready(p)
            remote = str(filename or "").strip()
            if not remote or "/" in remote or "\\" in remote or len(remote) > 160:
                raise Print3dError("Nom de fichier SD invalide")
            if not remote.lower().endswith(".3mf"):
                raise Print3dError("Lancement SD : fichier .3mf tranché requis", 422, "unsupported")
            opts = options if isinstance(options, dict) else {}
            if any(k in opts for k in ("ams_mapping", "use_ams", "gcode_tool_cnt", "use_matl_station", "material_mappings")):
                raise Print3dError("Le mapping des matériaux est géré côté serveur", 422, "mapping_override")
            local_id = self.library.find_by_job_name(remote)
            if not local_id:
                raise Print3dError("Lancement SD désactivé : fichier distant non vérifié localement", 422, "unverified_sd_file")
            stage_dir, staged_path, orig_name = self._stage_model_file(local_id)
            try:
                self._staged_local.path = staged_path
                self._staged_local.name = orig_name
                try:
                    plan = self.plan_print(printer_id, local_id, int(plate or 1))
                finally:
                    self._staged_local.path = None
                    self._staged_local.name = None
            finally:
                shutil.rmtree(stage_dir, ignore_errors=True)
            cfg = self._printer_cfg(printer_id)
            try:
                remote_bytes = bambu.fetch_file(cfg["ip"], cfg.get("code", ""), [remote])
            except bambu.BambuError:
                remote_bytes = b""
            if not remote_bytes or hashlib.sha256(remote_bytes).hexdigest() != plan["sha256"]:
                raise Print3dError("Contenu du fichier SD distant non vérifié ou différent", 422, "unverified_sd_file")
            link = self._links.get(printer_id)
            if link is None:
                raise Print3dError("Imprimante hors ligne", 503, "printer_offline")
            self._assert_printer_ready(self.printer(printer_id))
            stem = models.Library._job_stem(remote) or Path(remote).stem
            self._claim_pending_start(printer_id, {"at": _now(), "job": stem, "gen": self._link_gen.get(printer_id, 0), "ambiguous": False})
            try:
                link.start_print(bambu.project_file_command(
                    remote, plan["plate"], stem,
                    bool(plan["use_ams"]), [int(x) for x in plan["ams_mapping"]],
                    bed_levelling=bool(opts.get("bed_levelling", True)),
                    timelapse=bool(opts.get("timelapse", False)),
                    flow_cali=bool(opts.get("flow_cali", False)),
                    vibration_cali=bool(opts.get("vibration_cali", False)),
                    bed_type=str(opts.get("bed_type") or "auto"),
                ))
            except bambu.BambuError as exc:
                self._mark_pending_ambiguous(printer_id)
                raise Print3dError(str(exc), 502, "printer_error") from None
            with self._lock:
                if printer_id in self._status:
                    self._status[printer_id]["state"] = "preparing"
            return {"ok": True, "printer": p["name"], "file": remote, "plate": int(plate or 1)}
        finally:
            with self._lock:
                self._starting.discard(printer_id)

    # ── starting a print (only from a confirmed card) ──
    def plan_print(self, printer_id: str, model_id: str, plate: int | None = None) -> dict[str, Any]:
        """Check that this file can start on this printer now; returns what the card shows.

        Refuses an unsliced file, the wrong file type for the printer, a busy or offline
        printer, an unknown plate, or a Bambu job whose filaments are not loaded.
        """
        staged_local = getattr(self, "_staged_local", None)
        _staged_path = getattr(staged_local, "path", None) if staged_local is not None else None
        _source_name = getattr(staged_local, "name", None) if staged_local is not None else None
        printer = self.printer(printer_id)
        info = self.library.inspect_print_file(model_id, source_path=_staged_path, display_name=_source_name)
        self._assert_printer_ready(printer)
        plan: dict[str, Any] = {"printer_id": printer_id, "printer_name": printer["name"], "kind": printer["kind"],
                                "model_id": model_id, "file": info["name"], "size": info["size"],
                                "prediction_sec": info.get("prediction_sec"), "weight_g": info.get("weight_g"),
                                "sliced_for": info.get("printer_model") or ""}
        if printer["kind"] == "bambu":
            if info["kind"] != "bambu3mf":
                raise Print3dError("Ce fichier n'est pas tranché pour une Bambu (3MF avec G-code requis)",
                                   422, "not_sliced")
            plates = info["plates"]
            chosen = int(plate) if plate else plates[0]
            if chosen not in plates:
                raise Print3dError(f"Plateau {chosen} absent (plateaux : {plates})", 422, "bad_plate")
            info = self.library.inspect_print_file(model_id, chosen, source_path=_staged_path, display_name=_source_name)
            plan.update({
                "plate": chosen,
                "prediction_sec": info.get("prediction_sec"),
                "weight_g": info.get("weight_g"),
                "sliced_for": info.get("printer_model") or "",
            })
            slots = (printer.get("status") or {}).get("ams") or []
            plan["use_ams"], plan["ams_mapping"], plan["filament_plan"] = self._map_filaments(info["filaments"], slots)
        else:
            if info["kind"] not in ("gcode", "bambu3mf"):
                raise Print3dError("Flashforge : fichier .gcode, .gx ou .3mf tranché requis", 422, "not_sliced")
            plan["plate"] = None
            slots = (printer.get("status") or {}).get("ams") or []
            used_fils = [f for f in (info.get("filaments") or []) if f.get("id") or f.get("type")]
            if len(used_fils) > 1 or (slots and used_fils):
                use_st, ff_maps, ff_notes = self._map_flashforge_filaments(used_fils, slots)
                plan["use_matl_station"] = use_st
                plan["gcode_tool_cnt"] = len(used_fils) if len(used_fils) > 1 else (1 if ff_maps else 0)
                plan["material_mappings"] = ff_maps
                plan["filament_plan"] = ff_notes
            else:
                plan["use_matl_station"] = False
                plan["gcode_tool_cnt"] = 0
                plan["material_mappings"] = []
        if info["size"] > bambu.MAX_UPLOAD:
            raise Print3dError("Fichier trop grand", 413, "too_large")
        model_key = str(self._printer_cfg(printer_id).get("model") or "").strip()
        if model_key not in models.PRINTER_PROFILES:
            raise Print3dError(f"Modèle d'imprimante non vérifié ({printer['name']})", 422, "unknown_printer_profile")
        profile = dict(models.PRINTER_PROFILES[model_key])
        sliced_for = str(info.get("printer_model") or "").strip()
        if printer["kind"] == "bambu" and not sliced_for:
            raise Print3dError("Métadonnées de tranchage absentes (modèle cible requis)", 422, "not_sliced")
        canon_sliced = models.resolve_vendor_model_name(sliced_for) or sliced_for
        if sliced_for and canon_sliced.lower() != model_key.lower() and sliced_for.lower() != model_key.lower():
            raise Print3dError(f"Fichier tranché pour {sliced_for}, incompatible avec {model_key}", 422, "printer_mismatch")
        b = printer.get("bed") or {}
        if b.get("x") and b.get("y") and b.get("z"):
            vx, vy, vz = profile["bed"]
            profile["bed"] = (min(float(b["x"]), vx), min(float(b["y"]), vy), min(float(b["z"]), vz))
        src_path = _staged_path if _staged_path is not None else self.library.resolve(model_id)
        try:
            pf = models.preflight_gcode(src_path, plan.get("plate") or 1, profile)
        except models.ModelError as exc:
            raise Print3dError(str(exc), exc.status, exc.code) from None
        if printer["kind"] != "bambu":
            pf_tools = pf.get("tools") or []
            if len(pf_tools) > 1 or (pf_tools and max(pf_tools) >= 1):
                need_cnt = max(pf_tools) + 1
                slots = (printer.get("status") or {}).get("ams") or []
                if not slots and model_key != "Creator 5":
                    raise Print3dError(f"{model_key} requiert une station de filament pour le multi-outils", 422, "filament_mismatch")
                if not slots and need_cnt > 2:
                    raise Print3dError("Plus de 2 extrudeurs détectés sans station de filament", 422, "filament_mismatch")
                if int(plan.get("gcode_tool_cnt") or 0) < need_cnt:
                    plan["gcode_tool_cnt"] = need_cnt
        plan["sha256"] = models.file_sha256(src_path)
        try:
            prov = self.library.get_slice_provenance(model_id)
        except models.ModelError as exc:
            raise Print3dError(str(exc), exc.status, exc.code) from None
        is_internal = models.is_internal_sliced_name(info.get("name") or "")
        if is_internal or prov is not None:
            expected_sha = str((prov or {}).get("slice_sha256") or "").strip().lower()
            if not expected_sha:
                raise Print3dError(
                    "Provenance SHA-256 manquante pour l'artefact Studio — ré-tranchage requis",
                    422, "missing_slice_provenance",
                )
            if plan["sha256"].lower() != expected_sha:
                raise Print3dError("Empreinte SHA-256 de l'artefact tranché altérée", 422, "slice_tampered")
            plan["provenance_policy"] = "verified_slice_sha256"
        else:
            plan["provenance_policy"] = "external_preflight_only"
        spools = filament.list_spools(self.state_dir())
        spool_warnings: list[str] = []
        for f in info.get("filaments") or []:
            mat = filament.base_material(f.get("type"))
            need_g = float(f.get("g") or 0)
            if mat and need_g > 0:
                matching = [s for s in spools if s.get("material") == mat]
                if matching and all(float(s.get("remaining_g") or 0) < need_g for s in matching):
                    spool_warnings.append(f"Bobine {mat} faible (< {round(need_g, 1)} g requis)")
        if spool_warnings:
            plan["spool_warnings"] = spool_warnings
        return plan

    @staticmethod
    def _map_filaments(filaments: list[dict[str, Any]], slots: list[dict[str, Any]]) -> tuple[bool, list[int], list[str]]:
        used = [f for f in filaments if f.get("id")]
        if not slots:
            if len(used) > 1:
                raise Print3dError("Plusieurs filaments requis mais aucun AMS détecté", 422, "filament_mismatch")
            return False, [], ["bobine externe"]
        mapping = [-1] * max([f["id"] for f in used] or [0])
        notes = []
        used_slots = [s for s in slots if s.get("loaded") is not False]
        for f in used:
            want_type, want_col = f.get("type", "").upper(), f.get("colour", "")[:7].upper()
            pick = next((s for s in used_slots if s.get("material", "").upper() == want_type
                         and s.get("colour", "").upper() == want_col), None) \
                or next((s for s in used_slots if s.get("material", "").upper() == want_type), None)
            if pick is None:
                raise Print3dError(f"Aucun {want_type or 'filament'} chargé pour le filament {f['id']}",
                                   422, "filament_mismatch")
            mapping[f["id"] - 1] = int(pick["slot"]) - 1
            notes.append(f"{want_type} {want_col} → fente {pick['slot']}")
        return True, mapping, notes

    @staticmethod
    def _map_flashforge_filaments(filaments: list[dict[str, Any]],
                                  slots: list[dict[str, Any]]) -> tuple[bool, list[dict[str, Any]], list[str]]:
        if not filaments:
            return False, [], ["bobine active"]
        if not slots:
            if len(filaments) <= 1:
                return False, [], ["bobine externe"]
            if len(filaments) > 2:
                raise Print3dError("Plus de 2 extrudeurs requis mais aucune station de filament détectée",
                                   422, "filament_mismatch")
            notes = [f"T{i} ({f.get('type') or 'PLA'} {str(f.get('colour') or '')[:7]}) → extrudeur {i + 1}"
                     for i, f in enumerate(filaments)]
            return False, [], notes
        mappings: list[dict[str, Any]] = []
        notes = []
        used_slots = [s for s in slots if s.get("loaded") is not False]
        for i, f in enumerate(filaments[:16]):
            tool_id = (int(f["id"]) - 1) if f.get("id") else i
            want_type = str(f.get("type") or "").upper()
            want_col = str(f.get("colour") or "")[:7].upper()
            pick = next((s for s in used_slots if s.get("material", "").upper() == want_type
                         and str(s.get("colour") or "")[:7].upper() == want_col), None) \
                or next((s for s in used_slots if s.get("material", "").upper() == want_type), None)
            if pick is None and want_type:
                raise Print3dError(f"Aucun {want_type} chargé pour l'extrudeur T{tool_id}",
                                   422, "filament_mismatch")
            if pick is None:
                if not used_slots:
                    raise Print3dError(f"Aucune fente chargée pour l'extrudeur T{tool_id}", 422, "filament_mismatch")
                pick = used_slots[i % len(used_slots)]
            slot_col = str(pick.get("colour") or "#FFFFFF")[:7].upper()
            mappings.append({
                "toolId": tool_id,
                "slotId": int(pick["slot"]),
                "materialName": want_type or str(pick.get("material") or "PLA"),
                "toolMaterialColor": want_col if len(want_col) == 7 else "#FFFFFF",
                "slotMaterialColor": slot_col if len(slot_col) == 7 else "#FFFFFF",
            })
            notes.append(f"T{tool_id} ({want_type or 'PLA'}) → fente {pick['slot']}")
        return True, mappings, notes

    def start_print(self, printer_id: str, model_id: str, plate: int | None = None,
                    options: dict[str, Any] | None = None) -> dict[str, Any]:
        with self._lock:
            if printer_id in self._starting:
                raise Print3dError("Un envoi est déjà en cours sur cette imprimante", 409, "printer_busy")
            self._starting.add(printer_id)
        try:
            if options is None:
                return self._start_print(printer_id, model_id, plate)
            return self._start_print(printer_id, model_id, plate, options)
        finally:
            with self._lock:
                self._starting.discard(printer_id)

    def _stage_model_file(self, model_id: str) -> tuple[Path, Path, str]:
        orig_path = self.library.resolve(model_id)
        stage_dir = Path(tempfile.mkdtemp(prefix="hq_stage_"))
        staged_path = stage_dir / orig_path.name
        try:
            try:
                os.chmod(stage_dir, 0o700)
            except OSError:
                pass
            with open(orig_path, "rb") as src_f, open(staged_path, "wb") as dst_f:
                shutil.copyfileobj(src_f, dst_f, 1024 * 1024)
                dst_f.flush()
            try:
                os.chmod(staged_path, 0o600)
            except OSError:
                pass
            return stage_dir, staged_path, orig_path.name
        except Exception:
            shutil.rmtree(stage_dir, ignore_errors=True)
            raise

    def _start_print(self, printer_id: str, model_id: str, plate: int | None,
                     options: dict[str, Any] | None = None) -> dict[str, Any]:
        opts = options if isinstance(options, dict) else {}
        protected = {"ams_mapping", "use_ams", "gcode_tool_cnt", "use_matl_station", "material_mappings"}
        if any(k in opts for k in protected):
            raise Print3dError("Le mapping des outils et matériaux est géré côté serveur", 422, "mapping_override")
        stage_dir, staged_path, orig_name = self._stage_model_file(model_id)
        try:
            self._staged_local.path = staged_path
            self._staged_local.name = orig_name
            try:
                plan = self.plan_print(printer_id, model_id, plate)
            finally:
                self._staged_local.path = None
                self._staged_local.name = None
            link = self._links.get(printer_id)
            if link is None:
                raise Print3dError("Imprimante hors ligne", 503, "printer_offline")
            path = str(staged_path)
            if plan.get("sha256") and models.file_sha256(staged_path) != plan["sha256"]:
                raise Print3dError("Le fichier a été modifié pendant la vérification", 409, "file_changed")
            remote = re.sub(r"[^A-Za-z0-9 ._()-]", "_", plan["file"])[:120]
            cfg = self._printer_cfg(printer_id)
            stem = models.Library._job_stem(remote) or Path(remote).stem
            if plan["kind"] == "bambu":
                self._assert_printer_ready(self.printer(printer_id))
                self._claim_pending_start(printer_id, {"at": _now(), "job": stem, "gen": self._link_gen.get(printer_id, 0), "ambiguous": False})
                try:
                    bambu.upload(cfg["ip"], cfg.get("code", ""), path, remote)
                except bambu.BambuError as exc:
                    self._release_pending_start(printer_id)
                    raise Print3dError(str(exc), 502, "printer_error") from None
                try:
                    link.start_print(bambu.project_file_command(
                        remote, plan["plate"], stem,
                        bool(plan["use_ams"]), [int(x) for x in plan["ams_mapping"]],
                        bed_levelling=bool(opts.get("bed_levelling", True)),
                        timelapse=bool(opts.get("timelapse", False)),
                        flow_cali=bool(opts.get("flow_cali", False)),
                        vibration_cali=bool(opts.get("vibration_cali", False)),
                        bed_type=str(opts.get("bed_type") or "auto"),
                    ))
                except bambu.BambuError as exc:
                    self._mark_pending_ambiguous(printer_id)
                    raise Print3dError(str(exc), 502, "printer_error") from None
            else:
                try:
                    self._assert_printer_ready(self.printer(printer_id))
                    self._claim_pending_start(printer_id, {"at": _now(), "job": stem, "gen": self._link_gen.get(printer_id, 0), "ambiguous": False})
                    ff_cnt = int(plan.get("gcode_tool_cnt", 0) or 0)
                    ff_station = bool(plan.get("use_matl_station", False))
                    ff_maps = plan.get("material_mappings") or []
                    if opts or ff_cnt > 0 or ff_station or ff_maps:
                        link.start_print(
                            path, remote,
                            leveling=bool(opts.get("bed_levelling", True)),
                            flow_calibration=bool(opts.get("flow_cali", False)),
                            use_matl_station=ff_station,
                            gcode_tool_cnt=ff_cnt,
                            material_mappings=ff_maps,
                        )
                    else:
                        link.start_print(path, remote)
                except flashforge.FlashforgeError as exc:
                    self._mark_pending_ambiguous(printer_id)
                    raise Print3dError(str(exc), 502, "printer_error") from None
        finally:
            shutil.rmtree(stage_dir, ignore_errors=True)
        with self._lock:
            if printer_id in self._status:
                self._status[printer_id]["state"] = "preparing"
        try:
            meta = self.library.get(model_id)
            self.library.update_meta(model_id, {"printed_count": int(meta.get("printed_count") or 0) + 1})
        except Exception:
            pass
        return {"ok": True, "printer": plan["printer_name"], "file": plan["file"], "plate": plan.get("plate")}

    def camera_frame(self, printer_id: str) -> bytes:
        """One JPEG for Elsea to look at (opens the hub briefly if nobody watches)."""
        return self.camera_hub(printer_id).snapshot(timeout=8.0)

    def camera_hub(self, printer_id: str) -> CameraHub:
        self.printer(printer_id)
        hub = self._hubs.get(printer_id)
        if hub is None:
            raise Print3dError("Caméra indisponible", 503, "camera_unavailable")
        return hub

    # ── MakerWorld ──
    def _mw_path(self) -> Path:
        return self.state_dir() / MAKERWORLD_FILE

    def _mw_read(self, copy_data: bool = True) -> dict[str, Any]:
        """The MakerWorld snapshot, parsed at most once per (mtime, size).

        It keeps up to 400 history points: parsing it on every 4 s poll only to read ``last`` and
        ``alerts`` was pure waste. Read-only callers pass ``copy_data=False``.
        """
        p = self._mw_path()
        try:
            st = p.stat()
        except OSError:
            with self._lock:
                self._mw_cache = None
            return {"last": None, "history": [], "last_error": None, "last_attempt": 0}
        key = (st.st_mtime_ns, st.st_size)
        with self._lock:
            cached = self._mw_cache
        if cached is not None and cached[0] == key:
            return copy.deepcopy(cached[1]) if copy_data else cached[1]
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            raise Print3dError("statistiques illisibles — fichier conservé", 409, "state_unreadable") from None
        if not isinstance(data, dict):
            raise Print3dError("statistiques illisibles — fichier conservé", 409, "state_unreadable")
        data.setdefault("history", [])
        with self._lock:
            self._mw_cache = (key, data)
        return copy.deepcopy(data) if copy_data else data

    def makerworld(self, with_history: bool = True, cfg: dict[str, Any] | None = None) -> dict[str, Any]:
        data = self._mw_read(copy_data=False)
        mw = (cfg or self.public_config())["makerworld"]
        out = {"configured": bool(mw["handle"]), "handle": mw["handle"],
               "has_cookie": mw["has_cookie"], "last": data.get("last"),
               "last_error": data.get("last_error"), "last_attempt": data.get("last_attempt", 0),
               "refreshing": self._mw_running}
        if with_history:
            out["history"] = [{k: v for k, v in row.items() if k != "designs"} for row in data["history"]]
            hist = data["history"]
            out["design_deltas"] = {}
            if len(hist) >= 2:
                week_ago = _now() - 7 * 86400
                base = next((h for h in hist if (h.get("at") or 0) >= week_ago), hist[0])
                cur = hist[-1]
                for did, vals in (cur.get("designs") or {}).items():
                    old = (base.get("designs") or {}).get(did) or [0, 0, 0]
                    out["design_deltas"][did] = [vals[i] - (old[i] if i < len(old) else vals[i]) for i in range(3)]
        out["alerts"] = list(data.get("alerts") or [])[-10:]
        return out

    # ── models ↔ MakerWorld designs ──
    def _design_index(self) -> tuple[dict[int, dict[str, Any]], dict[str, list[int]]]:
        try:
            data = self._mw_read(copy_data=False)
        except Print3dError:
            return {}, {}
        designs = {int(d["id"]): d for d in ((data.get("last") or {}).get("designs") or []) if isinstance(d, dict)}
        deltas = self.makerworld().get("design_deltas") or {}
        return designs, {k: v for k, v in deltas.items()}

    def attach_makerworld(self, models_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Adds ``mw`` (title, counts, 7-day change, link) to each model linked to a design."""
        if not any(m.get("makerworld_design_id") for m in models_list):
            return models_list
        designs, deltas = self._design_index()
        for m in models_list:
            d = designs.get(int(m.get("makerworld_design_id") or 0))
            if d:
                slug = f"{d['id']}-{d['slug']}" if d.get("slug") else str(d["id"])
                m["mw"] = {"title": d.get("title", ""), "downloads": d.get("downloads", 0),
                           "prints": d.get("prints", 0), "likes": d.get("likes", 0),
                           "comments": d.get("comments", 0), "change_7d": deltas.get(str(d["id"])),
                           "url": f"https://makerworld.com/en/models/{slug}"}
            elif m.get("makerworld_design_id"):
                m["mw"] = None                              # linked, but not in the last snapshot
        return models_list

    def match_model(self, model_id: str) -> list[dict[str, Any]]:
        model = self.library.get(model_id)
        designs, _ = self._design_index()
        return hq_makerworld.match_designs(Path(model["name"]).stem, list(designs.values()))

    def refresh_makerworld(self, *, manual: bool = False,
                           opener: Callable[..., Any] | None = None) -> dict[str, Any]:
        with self._mw_lock:
            if self._mw_running:
                raise Print3dError("Rafraîchissement déjà en cours", 409, "busy")
            data = self._mw_read()
            if manual and _now() - int(data.get("last_attempt") or 0) < MW_MANUAL_MIN:
                raise Print3dError("Attends une minute entre deux rafraîchissements", 429, "rate_limited")
            self._mw_running = True
        try:
            mw = self._read_config().get("makerworld") or {}
            if not mw.get("handle"):
                raise Print3dError("Pseudo MakerWorld requis", 400, "makerworld_not_configured")
            kwargs: dict[str, Any] = {"uid": int(mw.get("uid") or 0), "cookie": mw.get("cookie") or "",
                                      "ua": mw.get("ua") or ""}
            if opener is not None:
                kwargs["opener"] = opener
            error = None
            snap = None
            try:
                snap = hq_makerworld.fetch(mw["handle"], **kwargs)
            except hq_makerworld.MakerWorldError as exc:
                error = {"code": exc.code, "message": str(exc), "at": _now()}
            fresh: list[dict[str, Any]] = []
            with hq_state.path_lock(self._mw_path()):
                data = self._mw_read()
                data["last_attempt"] = _now()
                if snap is not None:
                    try:
                        known = {a.get("id") for a in data.get("alerts") or []}
                        fresh = [a for a in hq_makerworld.detect_alerts(
                            data.get("last"), snap, data["history"], _now(),
                            hq_makerworld.clean_alert_settings(None, self._read_config().get("mw_alerts")))
                            if a["id"] not in known]
                        data["alerts"] = (list(data.get("alerts") or []) + fresh)[-hq_makerworld.MAX_ALERTS:]
                    except Exception:
                        fresh = []
                    data["last"] = snap
                    data["last_error"] = ({"code": snap["profile_error"], "message": "Profil bloqué ; totaux calculés "
                                           "depuis les modèles", "at": _now()} if snap.get("profile_error") else None)
                    data["history"] = (data["history"] + [hq_makerworld.history_point(snap)])[-MAX_MW_HISTORY:]
                    if snap.get("uid") and not mw.get("uid"):
                        self.save_settings({"uid": snap["uid"]})
                else:
                    data["last_error"] = error
                try:
                    hq_state.write_json_atomic(self._mw_path(), data)
                except RuntimeError as exc:
                    raise Print3dError(str(exc), 409, "state_unreadable") from exc
                with self._lock:
                    self._mw_cache = None
            if fresh and hq_makerworld.clean_alert_settings(None, self._read_config().get("mw_alerts"))["push"]:
                for a in fresh[:3]:
                    self._watch_notify("MakerWorld", a["text"])
            if snap is None and manual:
                raise Print3dError(error["message"], 502, error["code"])
            return self.makerworld()
        finally:
            self._mw_running = False

    def _timelapse_dir(self, printer_id: str) -> Path:
        d = self.state_dir() / "timelapses" / "_active" / printer_id
        d.mkdir(parents=True, exist_ok=True)
        return d

    def timelapse_path(self, job_id: str) -> Path:
        clean = re.sub(r"[^A-Za-z0-9_-]", "", str(job_id or ""))
        if not clean:
            raise Print3dError("Timelapse introuvable", 404, "not_found")
        p = self.state_dir() / "timelapses" / f"{clean}.mp4"
        if not p.is_file():
            raise Print3dError("Timelapse introuvable", 404, "not_found")
        return p

    def _capture_timelapse(self) -> None:
        now = _now()
        with self._lock:
            active = [(pid, dict(job)) for pid, job in self._jobs.items() if job.get("printed")]
        for pid, _job in active:
            if now - self._tl_last.get(pid, 0) < 15:
                continue
            hub = self._hubs.get(pid)
            if hub is None:
                continue
            with hub._cond:
                frame = hub._frame
                fresh = bool(frame) and (time.monotonic() - hub._frame_at < 30.0)
            if not fresh:
                continue
            self._tl_last[pid] = now
            try:
                tdir = self._timelapse_dir(pid)
                idx = len(list(tdir.glob("frame_*.jpg"))) + 1
                if idx <= 2400:
                    (tdir / f"frame_{idx:05d}.jpg").write_bytes(frame)
            except OSError:
                pass

    def _finish_timelapse(self, printer_id: str, job_id: str) -> str:
        tdir = self.state_dir() / "timelapses" / "_active" / printer_id
        if not tdir.is_dir():
            return ""
        frames = sorted(tdir.glob("frame_*.jpg"))
        if len(frames) < 5 or not shutil.which("ffmpeg"):
            shutil.rmtree(tdir, ignore_errors=True)
            return ""
        out_dir = self.state_dir() / "timelapses"
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file = out_dir / f"{job_id}.mp4"
        staging = out_dir / f"_staging_{job_id}"
        try:
            tdir.rename(staging)
        except OSError:
            return ""

        def _build() -> None:
            try:
                subprocess.run(
                    ["ffmpeg", "-y", "-framerate", "15", "-i", str(staging / "frame_%05d.jpg"),
                     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out_file)],
                    capture_output=True, timeout=120, check=False,
                )
            except Exception:
                pass
            finally:
                shutil.rmtree(staging, ignore_errors=True)

        threading.Thread(target=_build, name=f"tl-{job_id}", daemon=True).start()
        return f"{job_id}.mp4"

    def tick(self) -> None:
        """Background hook (bridge ``_hq_background``). Never raises."""
        try:
            self.ensure_links()
            cfg = self._read_config()
            self.watch.tick(self._watch_targets(), watch.clean_settings(None, cfg.get("watch")))
            self._capture_timelapse()
            if (cfg.get("makerworld") or {}).get("handle"):
                data = self._mw_read()
                if _now() - int(data.get("last_attempt") or 0) >= MW_INTERVAL:
                    threading.Thread(target=self._tick_mw, name="makerworld", daemon=True).start()
        except Exception:
            pass

    def _watch_targets(self) -> list[dict[str, Any]]:
        with self._lock:
            return [{"id": pid, "name": next((p.get("name") for p in self._cfg_printers() if p.get("id") == pid), pid),
                     "state": (self._status.get(pid) or {}).get("state"),
                     "progress": (self._status.get(pid) or {}).get("progress"),
                     "job_start": (self._jobs.get(pid) or {}).get("start")} for pid in list(self._status)]

    def _cfg_printers(self) -> list[dict[str, Any]]:
        try:
            return [p for p in self._read_config()["printers"] if isinstance(p, dict)]
        except Print3dError:
            return []

    @staticmethod
    def _watch_notify(title: str, body: str) -> None:
        try:
            import hq_automation
            hq_automation.send_push(title, body, category="attention", url="/")
        except Exception:
            pass

    def _tick_mw(self) -> None:
        try:
            self.refresh_makerworld()
        except Exception:
            pass

    # ── HTTP (JSON routes; binary ones are streamed by the bridge) ──
    # ── Print Farm Queue, Maintenance & Cost Logging ──
    def _queue_path(self) -> Path:
        return self.state_dir() / "queue.json"

    def _read_queue_json(self) -> list[dict[str, Any]]:
        p = self._queue_path()
        if not p.exists():
            return []
        try:
            raw = p.read_text(encoding="utf-8")
        except OSError as exc:
            raise Print3dError("File d'attente illisible", 500, "state_unreadable") from exc
        if not raw.strip():
            return []
        try:
            data = json.loads(raw)
        except ValueError as exc:
            raise Print3dError("File d'attente corrompue", 500, "state_unreadable") from exc
        if isinstance(data, list):
            if not all(isinstance(r, dict) and r.get("id") and r.get("model_id") for r in data):
                raise Print3dError("Schéma de file d'attente invalide", 500, "state_unreadable")
            return list(data)
        if isinstance(data, dict) and isinstance(data.get("items"), list):
            if not all(isinstance(r, dict) and r.get("id") and r.get("model_id") for r in data["items"]):
                raise Print3dError("Schéma de file d'attente invalide", 500, "state_unreadable")
            return list(data["items"])
        raise Print3dError("Schéma de file d'attente invalide", 500, "state_unreadable")

    def queue_list(self) -> list[dict[str, Any]]:
        db_path = self.state_dir() / "pending_starts.db"
        if db_path.exists():
            try:
                conn = self._pending_db_conn()
                try:
                    migrated = conn.execute("SELECT value FROM queue_meta WHERE key='migrated_v1'").fetchone()
                    if migrated is not None:
                        rows = conn.execute("SELECT payload FROM queue_items ORDER BY seq ASC").fetchall()
                        return [json.loads(r[0]) for r in rows]
                finally:
                    conn.close()
            except (sqlite3.Error, ValueError) as exc:
                raise Print3dError("File d'attente illisible", 500, "state_unreadable") from exc
        return self._read_queue_json()

    def _write_queue(self, items: list[dict[str, Any]]) -> None:
        hq_state.write_json_atomic(self._queue_path(), {"items": items[:100]})

    def _migrate_queue_db_once(self, conn: sqlite3.Connection) -> list[dict[str, Any]]:
        migrated = conn.execute("SELECT value FROM queue_meta WHERE key='migrated_v1'").fetchone()
        if migrated is None:
            items = self._read_queue_json()
            for idx, it in enumerate(items, 1):
                conn.execute(
                    "INSERT OR IGNORE INTO queue_items (id, seq, payload) VALUES (?, ?, ?)",
                    (str(it["id"]), idx, json.dumps(it)),
                )
            conn.execute("INSERT OR REPLACE INTO queue_meta (key, value) VALUES ('migrated_v1', '1')")
        rows = conn.execute("SELECT payload FROM queue_items ORDER BY seq ASC").fetchall()
        return [json.loads(r[0]) for r in rows]

    def queue_add(self, model_id: str, plate: int = 1, printer_id: str = "auto",
                  options: dict[str, Any] | None = None) -> dict[str, Any]:
        info = self.library.inspect_print_file(model_id, plate)
        if not info.get("kind"):
            raise Print3dError("Fichier non tranché : tranche-le avant de le mettre en file", 422, "not_sliced")
        row = {
            "id": "q-" + secrets.token_hex(3),
            "model_id": model_id,
            "name": info["name"],
            "plate": int(plate or 1),
            "printer_id": str(printer_id or "auto")[:32],
            "options": options if isinstance(options, dict) else {},
            "added_at": _now(),
        }
        items: list[dict[str, Any]] = []
        with hq_state.path_lock(self._queue_path()):
            conn = self._pending_db_conn()
            try:
                conn.execute("BEGIN IMMEDIATE")
                items = self._migrate_queue_db_once(conn)
                count = int(conn.execute("SELECT COUNT(*) FROM queue_items").fetchone()[0])
                if count >= 100:
                    conn.execute("ROLLBACK")
                    raise Print3dError("File d'attente pleine (max 100)", 409, "queue_full")
                next_seq = int(conn.execute("SELECT COALESCE(MAX(seq), 0) + 1 FROM queue_items").fetchone()[0])
                conn.execute(
                    "INSERT INTO queue_items (id, seq, payload) VALUES (?, ?, ?)",
                    (row["id"], next_seq, json.dumps(row)),
                )
                items.append(row)
                conn.execute("COMMIT")
            except sqlite3.Error as exc:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise Print3dError("Verrouillage de file impossible", 503, "state_unwritable") from exc
            finally:
                conn.close()
            try:
                self._write_queue(items)
            except (OSError, RuntimeError):
                pass
        return row

    def queue_remove(self, item_id: str, force: bool = False) -> bool:
        with hq_state.path_lock(self._queue_path()):
            conn = self._pending_db_conn()
            kept: list[dict[str, Any]] = []
            try:
                conn.execute("BEGIN IMMEDIATE")
                items = self._migrate_queue_db_once(conn)
                target = next((x for x in items if x.get("id") == item_id), None)
                if target is None:
                    conn.execute("ROLLBACK")
                    return False
                if not force:
                    claim = conn.execute("SELECT status FROM queue_claims WHERE item_id=?", (item_id,)).fetchone()
                    if (claim is not None and claim[0] in ("dispatching", "ambiguous")) or target.get("status") in ("dispatching", "ambiguous"):
                        conn.execute("ROLLBACK")
                        raise Print3dError("Élément en cours d'envoi ou ambigu — réconciliation requise", 409, "queue_busy")
                kept = [x for x in items if x.get("id") != item_id]
                conn.execute("DELETE FROM queue_items WHERE id=?", (item_id,))
                conn.execute("DELETE FROM queue_claims WHERE item_id=?", (item_id,))
                conn.execute("COMMIT")
            except sqlite3.Error as exc:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise Print3dError("Verrouillage de file impossible", 503, "state_unwritable") from exc
            finally:
                conn.close()
            try:
                self._write_queue(kept)
            except (OSError, RuntimeError):
                pass
            return True

    def queue_dispatch(self, item_id: str) -> dict[str, Any]:
        with hq_state.path_lock(self._queue_path()):
            conn = self._pending_db_conn()
            try:
                conn.execute("BEGIN IMMEDIATE")
                claim = conn.execute("SELECT status FROM queue_claims WHERE item_id=?", (item_id,)).fetchone()
                if claim is not None:
                    conn.execute("ROLLBACK")
                    raise Print3dError("Élément déjà en cours d'envoi", 409, "printer_busy")
                items = self._migrate_queue_db_once(conn)
                item = next((x for x in items if x.get("id") == item_id), None)
                if item is None:
                    conn.execute("ROLLBACK")
                    raise Print3dError("Élément de file introuvable", 404, "not_found")
                if item.get("status", "pending") != "pending":
                    conn.execute("ROLLBACK")
                    raise Print3dError("Élément déjà en cours d'envoi", 409, "printer_busy")
                conn.execute(
                    "INSERT INTO queue_claims (item_id, status, updated_at) VALUES (?, 'dispatching', ?)",
                    (item_id, time.time()),
                )
                item["status"] = "dispatching"
                conn.execute("UPDATE queue_items SET payload=? WHERE id=?", (json.dumps(item), item_id))
                conn.execute("COMMIT")
            except sqlite3.Error as exc:
                try:
                    conn.execute("ROLLBACK")
                except sqlite3.Error:
                    pass
                raise Print3dError("Verrouillage de file impossible", 503, "state_unwritable") from exc
            finally:
                conn.close()
            try:
                self._write_queue(items)
            except (OSError, RuntimeError):
                pass
        started = False
        try:
            candidates = self.printers()
            target_id = item.get("printer_id")
            if target_id and target_id != "auto":
                candidates = [p for p in candidates if p["id"] == target_id]
            last_err: Exception | None = None
            res: dict[str, Any] | None = None
            for p in candidates:
                try:
                    res = self.start_print(p["id"], item["model_id"], item.get("plate"), item.get("options"))
                    started = True
                    break
                except Print3dError as exc:
                    if exc.code == "printer_error":
                        raise
                    last_err = exc
            if not started or res is None:
                raise last_err or Print3dError("Aucune imprimante compatible libre", 409, "printer_busy")
            self.queue_remove(item_id, force=True)
            return {**res, "dispatched_id": item_id}
        except Exception as exc:
            ambiguous = started or (isinstance(exc, Print3dError) and exc.code == "printer_error")
            with hq_state.path_lock(self._queue_path()):
                conn = self._pending_db_conn()
                cur: list[dict[str, Any]] = []
                try:
                    conn.execute("BEGIN IMMEDIATE")
                    if ambiguous:
                        conn.execute(
                            "UPDATE queue_claims SET status='ambiguous', updated_at=? WHERE item_id=?",
                            (time.time(), item_id),
                        )
                    else:
                        conn.execute("DELETE FROM queue_claims WHERE item_id=?", (item_id,))
                    cur = self._migrate_queue_db_once(conn)
                    for x in cur:
                        if x.get("id") == item_id and x.get("status") == "dispatching":
                            x["status"] = "ambiguous" if ambiguous else "pending"
                            conn.execute("UPDATE queue_items SET payload=? WHERE id=?", (json.dumps(x), item_id))
                    conn.execute("COMMIT")
                except (OSError, RuntimeError, Print3dError, sqlite3.Error):
                    try:
                        conn.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                finally:
                    conn.close()
                try:
                    if cur:
                        self._write_queue(cur)
                except (OSError, RuntimeError):
                    pass
            raise

    def maintenance_summary(self, cfg: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        cfg = cfg or self._read_config()
        maint_cfg = cfg.get("maintenance") if isinstance(cfg.get("maintenance"), dict) else {}
        jobs = self._read_jobs()
        out = []
        for p in cfg.get("printers") or []:
            if not isinstance(p, dict):
                continue
            pid = p.get("id") or ""
            m = maint_cfg.get(pid) if isinstance(maint_cfg.get(pid), dict) else {}
            nozzle_at = int(m.get("nozzle_at") or 0)
            lube_at = int(m.get("lube_at") or 0)
            clean_at = int(m.get("clean_at") or 0)
            tot_sec = noz_sec = lube_sec = clean_sec = 0
            for j in jobs:
                if j.get("printer") != pid:
                    continue
                d = int(j.get("duration_sec") or 0)
                at = int(j.get("at") or 0)
                tot_sec += d
                if at >= nozzle_at:
                    noz_sec += d
                if at >= lube_at:
                    lube_sec += d
                if at >= clean_at:
                    clean_sec += d
            noz_h, lube_h, clean_h = round(noz_sec / 3600.0, 1), round(lube_sec / 3600.0, 1), round(clean_sec / 3600.0, 1)
            due = []
            if noz_h >= 250:
                due.append("Buse (≥ 250 h)")
            if lube_h >= 100:
                due.append("Lubrification axes (≥ 100 h)")
            if clean_h >= 25:
                due.append("Nettoyage plateau (≥ 25 h)")
            out.append({
                "printer_id": pid,
                "printer_name": p.get("name") or pid,
                "total_hours": round(tot_sec / 3600.0, 1),
                "nozzle_hours": noz_h,
                "lube_hours": lube_h,
                "clean_hours": clean_h,
                "due": due,
            })
        return out

    def reset_maintenance(self, printer_id: str, kind: str) -> list[dict[str, Any]]:
        self.printer(printer_id)
        if kind not in ("nozzle", "lube", "clean"):
            raise Print3dError("Type d'entretien invalide")
        with self._lock, hq_state.path_lock(self._config_path()):
            cfg = self._read_config()
            maint = cfg.setdefault("maintenance", {})
            entry = maint.setdefault(printer_id, {})
            entry[f"{kind}_at"] = _now()
            self._write_config(cfg)
        return self.maintenance_summary()

    def log_job_cost(self, job_id: str, *, kwh_rate: float = 0.12, machine_rate_hr: float = 0.50,
                     project_id: str = "") -> dict[str, Any]:
        with hq_state.path_lock(self._history_path()):
            jobs = self._read_jobs()
            job = next((j for j in jobs if j.get("id") == job_id), None)
            if job is None:
                raise Print3dError("Impression introuvable", 404, "not_found")
            settings = self.filament_settings()
            fil_cost = filament.job_cost(job.get("filament"), settings) or 0.0
            hours = float(job.get("duration_sec") or 0) / 3600.0
            elec_cost = round(hours * 0.15 * max(0.0, float(kwh_rate)), 2)
            mach_cost = round(hours * max(0.0, float(machine_rate_hr)), 2)
            total_cost = round(fil_cost + elec_cost + mach_cost, 2)
            job["cost_breakdown"] = {
                "filament": round(fil_cost, 2),
                "electricity": elec_cost,
                "machine": mach_cost,
                "total": total_cost,
                "project_id": str(project_id or "")[:64],
                "logged_at": _now(),
            }
            self._write_jobs(jobs)
        return job

    def overview(self) -> dict[str, Any]:
        # One config read feeds all blocks: this route is polled every few seconds.
        cfg = self.public_config()
        return {"ok": True, "printers": self._printers_from(cfg), "config": cfg,
                "makerworld": self.makerworld(with_history=False, cfg=cfg),
                "history": self.history(10, cfg["filament"]),
                "queue": self.queue_list(),
                "maintenance": self.maintenance_summary(cfg),
                "slicer_available": bool(models.Library.find_slicer())}

    def http_get(self, path: str, query: dict[str, str]) -> tuple[int, dict[str, Any]]:
        if path == "/api/print3d/state":
            return 200, self.overview()
        if path == "/api/print3d/printers":
            return 200, {"ok": True, "printers": self.printers()}
        if path == "/api/print3d/history":
            return 200, {"ok": True, "jobs": self.history(int(query.get("limit") or 50))}
        if path == "/api/print3d/filament":
            return 200, self.filament_stats(query.get("period") or "30d")
        if path == "/api/print3d/models":
            # brief: the grid shows no notes — the sheet reads the full record from models/get
            res = self.library.list(query.get("q", ""), query.get("origin", ""), query.get("tag", ""),
                                    limit=int(query.get("limit") or 500), offset=int(query.get("offset") or 0),
                                    brief=True)
            self.attach_makerworld(res["models"])
            return 200, {"ok": True, **res}
        if path == "/api/print3d/models/get":
            model = self.library.get(query.get("id", ""))
            self.attach_makerworld([model])
            return 200, {"ok": True, "model": model}
        if path == "/api/print3d/models/match":
            return 200, {"ok": True, "candidates": self.match_model(query.get("id", ""))}
        if path == "/api/print3d/makerworld":
            return 200, {"ok": True, **self.makerworld()}
        if path == "/api/print3d/printer/sd":
            return 200, {"ok": True, "files": self.list_sd_files(query.get("id", ""))}
        if path == "/api/print3d/models/inspect":
            plate = int(query.get("plate") or 1)
            return 200, {"ok": True, "info": self.library.inspect_print_file(query.get("id", ""), plate)}
        if path == "/api/print3d/models/layers":
            plate = int(query.get("plate") or 1)
            return 200, {"ok": True, **self.library.gcode_layers(query.get("id", ""), plate)}
        if path == "/api/print3d/spools":
            return 200, {"ok": True, "spools": filament.list_spools(self.state_dir())}
        if path == "/api/print3d/models/mesh_check":
            return 200, {"ok": True, **self.library.analyze_stl(query.get("id", ""), auto_orient=False)}
        if path == "/api/print3d/queue":
            return 200, {"ok": True, "items": self.queue_list()}
        if path == "/api/print3d/maintenance":
            return 200, {"ok": True, "maintenance": self.maintenance_summary()}
        if path == "/api/print3d/studio/schema":
            pid = str(query.get("printer_id") or "").strip()
            model_key = str(query.get("model") or "").strip()
            if pid and not model_key:
                model_key = str(self._printer_cfg(pid).get("model") or "").strip()
            if not model_key:
                raise Print3dError("Modèle d'imprimante requis", 400, "missing_printer_model")
            try:
                return 200, models.inspect_printer_slicer_defaults(
                    model_key,
                    nozzle=query.get("nozzle") or None,
                    material=str(query.get("material") or "PLA"),
                    plate_type=str(query.get("plate_type") or "textured_pei"),
                    quality_preset=str(query.get("quality_preset") or "standard"),
                    slicer_path=models.Library.find_slicer(),
                )
            except models.SlicerConfigError as exc:
                raise Print3dError(str(exc), exc.status, exc.code) from None
        if path == "/api/print3d/studio/loaded_materials":
            return 200, self.studio_loaded_materials(str(query.get("printer_id") or ""))
        if path == "/api/print3d/projects":
            limit = int(query.get("limit") or 100)
            return 200, {"ok": True, "projects": projects.list_projects(self.state_dir(), limit=limit)}
        if path == "/api/print3d/projects/get":
            try:
                return 200, projects.open_project(self.state_dir(), str(query.get("id") or ""), self.library)
            except projects.ProjectError as exc:
                raise Print3dError(str(exc), exc.status, exc.code) from None
        return 404, {"error": "Route Atelier 3D inconnue", "code": "not_found"}

    def studio_loaded_materials(self, printer_id: str) -> dict[str, Any]:
        """Read-only snapshot of loaded AMS/IFS material slots + inventory spools (never sends hardware commands)."""
        pid = str(printer_id or "").strip()
        if not pid:
            raise Print3dError("Identifiant imprimante requis", 400, "missing_printer")
        pcfg = self._printer_cfg(pid)
        model_key = str(pcfg.get("model") or "").strip()
        caps = models.printer_capabilities(model_key) if model_key else {}
        link_state = dict(self._link.get(pid) or {})
        raw_status = dict(self._status_cache(pid) if hasattr(self, "_status_cache") else {})
        if not raw_status:
            pr_list = [p for p in self.printers() if p.get("id") == pid]
            raw_status = (pr_list[0].get("status") or {}) if pr_list else {}
        slots = [dict(s) for s in (raw_status.get("ams") or []) if isinstance(s, dict)]
        online = bool(link_state.get("online"))
        if not online and not slots:
            avail, reason = False, "offline"
        elif not slots:
            avail, reason = False, ("no_station" if int(caps.get("max_tools") or 1) <= 1 else "no_station_reported")
        else:
            avail, reason = True, "live_status"
        return {
            "ok": True,
            "printer_id": pid,
            "printer_model": model_key,
            "station_kind": caps.get("station_kind") or "external_spool",
            "physical_extruders": int(caps.get("physical_extruders") or 1),
            "max_tools": int(caps.get("max_tools") or 1),
            "available": avail,
            "reason": reason,
            "online": online,
            "slots": slots,
            "spools": filament.list_spools(self.state_dir()),
        }

    def _resolve_slice_printer(self, data: dict[str, Any]) -> tuple[str, tuple[float, float, float] | None]:
        """Resolve authoritative printer model and bed bounds for slice routes."""
        pid = str(data.get("printer_id") or "").strip()
        req_model = str(data.get("printer_model") or "").strip()
        bed: tuple[float, float, float] | None = None
        if pid:
            pcfg = self._printer_cfg(pid)
            stored_model = str(pcfg.get("model") or "").strip()
            if not stored_model or stored_model not in models.CANONICAL_PROFILES:
                raise Print3dError(
                    f"Modèle d'imprimante non configuré pour {pcfg.get('name') or pid}",
                    422, "unknown_printer_profile",
                )
            if req_model and req_model != stored_model:
                raise Print3dError(
                    f"Modèle demandé ({req_model}) différent de celui configuré ({stored_model})",
                    422, "printer_mismatch",
                )
            b = _bed_for_printer(pcfg) or {}
            if b.get("x") and b.get("y") and b.get("z"):
                cbx, cby, cbz = models.CANONICAL_PROFILES[stored_model]["bed"]
                bed = (
                    min(float(b["x"]), cbx),
                    min(float(b["y"]), cby),
                    min(float(b["z"]), cbz),
                )
            return stored_model, bed
        if not req_model:
            raise Print3dError("Modèle d'imprimante cible requis", 400, "missing_printer_model")
        return req_model, None

    def http_post(self, path: str, data: dict[str, Any]) -> tuple[int, dict[str, Any]]:
        if path == "/api/print3d/printer/save":
            return 200, {"ok": True, "config": self.save_printer(data)}
        if path == "/api/print3d/printer/delete":
            return 200, {"ok": True, "config": self.delete_printer(str(data.get("id") or ""))}
        if path == "/api/print3d/printer/control":
            return 200, self.direct_command(str(data.get("id") or ""), str(data.get("action") or ""), data)
        if path == "/api/print3d/printer/start":
            plate = data.get("plate")
            return 200, self.start_print(str(data.get("printer_id") or ""), str(data.get("model_id") or ""),
                                         int(plate) if plate is not None else None, data)
        if path == "/api/print3d/printer/start_sd":
            return 200, self.start_sd_print(str(data.get("printer_id") or ""), str(data.get("file") or ""),
                                            int(data.get("plate") or 1), data)
        if path == "/api/print3d/models/slice":
            model_key, _bed = self._resolve_slice_printer(data)
            lh = data.get("layer_height")
            flh = data.get("first_layer_height")
            wl = data.get("wall_loops")
            inf = data.get("infill")
            return 200, {"ok": True, "model": self.library.slice_model(
                str(data.get("id") or ""), model_key,
                nozzle=data.get("nozzle"),
                material=str(data.get("material") or "") or None,
                plate_type=str(data.get("plate_type") or "textured_pei"),
                layer_height=float(lh) if lh not in (None, "") else None,
                first_layer_height=float(flh) if flh not in (None, "") else None,
                wall_loops=int(wl) if wl not in (None, "") else None,
                infill=int(inf) if inf not in (None, "") else None,
                infill_pattern=str(data.get("infill_pattern") or "") or None,
                supports=bool(data.get("supports")),
                support_type=str(data.get("support_type") or "") or None,
                brim=bool(data.get("brim")),
                brim_type=str(data.get("brim_type") or "") or None,
            )}
        if path == "/api/print3d/models/orient":
            return 200, {"ok": True, **self.library.analyze_stl(str(data.get("id") or ""), auto_orient=True)}
        if path == "/api/print3d/studio/slice":
            model_key, bed = self._resolve_slice_printer(data)
            return 200, {"ok": True, **self.library.assemble_and_slice_plate(
                data.get("items") or [],
                model_key,
                data.get("settings"),
                bed=bed)}
        if path == "/api/print3d/queue/add":
            return 200, {"ok": True, "item": self.queue_add(
                str(data.get("model_id") or ""), int(data.get("plate") or 1),
                str(data.get("printer_id") or "auto"), data.get("options"))}
        if path == "/api/print3d/queue/delete":
            return 200, {"ok": self.queue_remove(str(data.get("id") or ""))}
        if path == "/api/print3d/queue/dispatch":
            return 200, self.queue_dispatch(str(data.get("id") or ""))
        if path == "/api/print3d/maintenance/reset":
            return 200, {"ok": True, "maintenance": self.reset_maintenance(
                str(data.get("printer_id") or ""), str(data.get("kind") or ""))}
        if path == "/api/print3d/history/log_cost":
            return 200, {"ok": True, "job": self.log_job_cost(
                str(data.get("id") or ""),
                kwh_rate=float(data.get("kwh_rate") or 0.12),
                machine_rate_hr=float(data.get("machine_rate_hr") or 0.50),
                project_id=str(data.get("project_id") or ""))}
        if path == "/api/print3d/spools/save":
            return 200, {"ok": True, "spool": filament.save_spool(self.state_dir(), data)}
        if path == "/api/print3d/spools/delete":
            return 200, {"ok": filament.delete_spool(self.state_dir(), str(data.get("id") or ""))}
        if path == "/api/print3d/settings":
            return 200, {"ok": True, "config": self.save_settings(data)}
        if path == "/api/print3d/history/edit":
            return 200, {"ok": True, "job": self.edit_job(str(data.get("id") or ""), data)}
        if path == "/api/print3d/history/delete":
            return 200, self.delete_job(str(data.get("id") or ""))
        if path == "/api/print3d/makerworld/refresh":
            return 200, {"ok": True, **self.refresh_makerworld(manual=True)}
        if path == "/api/print3d/models/meta":
            return 200, {"ok": True, "model": self.library.update_meta(str(data.get("id") or ""),
                                                                       {k: v for k, v in data.items() if k != "id"})}
        if path == "/api/print3d/models/rescan":
            self.library.scan(force=True)
            return 200, {"ok": True, **self.library.list(brief=True)}
        if path == "/api/print3d/projects/save":
            try:
                return 200, {"ok": True, "project": projects.save_project(self.state_dir(), data)}
            except projects.ProjectError as exc:
                raise Print3dError(str(exc), exc.status, exc.code) from None
        if path == "/api/print3d/projects/duplicate":
            try:
                proj = projects.duplicate_project(
                    self.state_dir(), str(data.get("id") or ""), str(data.get("title") or "")
                )
                return 200, {"ok": True, "project": proj}
            except projects.ProjectError as exc:
                raise Print3dError(str(exc), exc.status, exc.code) from None
        if path == "/api/print3d/projects/rename":
            try:
                exp_rev = int(data["expected_revision"]) if data.get("expected_revision") is not None else None
                proj = projects.rename_project(
                    self.state_dir(), str(data.get("id") or ""), str(data.get("title") or ""),
                    expected_revision=exp_rev, force_overwrite=data.get("force_overwrite"),
                )
                return 200, {"ok": True, "project": proj}
            except (projects.ProjectError, ValueError, TypeError) as exc:
                status = getattr(exc, "status", 400)
                code = getattr(exc, "code", "validation_error")
                raise Print3dError(str(exc), status, code) from None
        if path == "/api/print3d/projects/delete":
            try:
                exp_rev = int(data["expected_revision"]) if data.get("expected_revision") is not None else None
                deleted = projects.delete_project(
                    self.state_dir(), str(data.get("id") or ""),
                    expected_revision=exp_rev, force_overwrite=data.get("force_overwrite"),
                )
                return 200, {"ok": deleted}
            except (projects.ProjectError, ValueError, TypeError) as exc:
                status = getattr(exc, "status", 400)
                code = getattr(exc, "code", "validation_error")
                raise Print3dError(str(exc), status, code) from None
        return 404, {"error": "Route Atelier 3D inconnue", "code": "not_found"}


_controllers: dict[str, Controller] = {}
_ctl_lock = threading.Lock()


def controller(root: str | Path, print_root: Callable[[], Path | None] | None = None) -> Controller:
    key = str(Path(root).resolve())
    with _ctl_lock:
        ctl = _controllers.get(key)
        if ctl is None:
            ctl = Controller(Path(root), print_root)
            _controllers[key] = ctl
        elif print_root is not None:
            ctl._print_root = print_root
        return ctl


def shutdown() -> None:
    with _ctl_lock:
        for ctl in _controllers.values():
            ctl.shutdown()
