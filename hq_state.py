"""Atomic JSON persistence for Transfert HQ v7 state files.

One lock per path. Writers serialize to a sibling ``*.json.tmp``, flush, fsync,
then ``os.replace``. A file that is not valid JSON is left untouched.

Companion secrets live in ``<root>/.hq-agent-state/``. The temp file is created
in that same directory, so it inherits the directory ACL before replace.
"""

from __future__ import annotations

import json
import os
import tempfile
import threading
from contextvars import ContextVar
from pathlib import Path
from typing import Any

_GUARD = threading.Lock()
_LOCKS: dict[str, threading.RLock] = {}

# One root for the stores that fall back to "the project". A store that is not
# explicitly bound resolves here, and a test that binds its own root cannot reach
# the live tree by forgetting a patch. Unbound, the working directory is the root,
# which is what a plain `python` run of this project always meant.
_STATE_ROOT: ContextVar[Path | None] = ContextVar("hq_state_root", default=None)


def bind_root(root: Path | str | None) -> None:
    """Point every unbound store at one root (tests bind a temp dir)."""
    _STATE_ROOT.set(None if root is None else Path(root))


def state_root() -> Path:
    """The bound root, or the working directory when nothing is bound."""
    return _STATE_ROOT.get() or Path(".")

# Private directory for companion secrets. Not the artifact inbox.
AGENT_STATE_DIR = ".hq-agent-state"
AGENT_STATE_FILES = ("hq_agents.json", "hq_agent_jobs.json", "hq_planner.json")


def agent_state_dir(root: Path | str) -> Path:
    return Path(root) / AGENT_STATE_DIR


def prepare_agent_state(root: Path | str) -> Path:
    """Create the private state directory and migrate legacy root files once.

    A legacy file moves only when the destination is absent. If both copies
    exist, nothing is chosen and nothing is overwritten. Bytes are not parsed,
    so a malformed file is preserved. No file contents are logged.
    """
    base = Path(root)
    dest_dir = agent_state_dir(base)
    planned: list[tuple[Path, Path]] = []
    conflicts: list[str] = []
    for name in AGENT_STATE_FILES:
        old = base / name
        new = dest_dir / name
        if old.exists() and new.exists():
            conflicts.append(name)
            continue
        if old.exists():
            if not old.is_file():
                raise RuntimeError(f"{name} conservé — pas un fichier")
            planned.append((old, new))
    if conflicts:
        raise RuntimeError(
            "état agent en double ("
            + ", ".join(conflicts)
            + ") — présent à la racine et dans .hq-agent-state. Aucun fichier écrasé."
        )
    if dest_dir.is_symlink():
        raise RuntimeError(".hq-agent-state ne peut pas être un lien symbolique")
    dest_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if dest_dir.is_symlink():
        raise RuntimeError(".hq-agent-state ne peut pas être un lien symbolique")
    if os.name == "posix":
        try:
            os.chmod(dest_dir, 0o700)
        except OSError:
            pass
    linked: list[tuple[Path, Path]] = []
    try:
        for old, new in planned:
            if new.exists():
                raise RuntimeError(f"{old.name} déjà présent dans .hq-agent-state — aucun fichier écrasé")
            try:
                os.link(old, new)
            except FileExistsError as exc:
                raise RuntimeError(f"{old.name} déjà présent dans .hq-agent-state — aucun fichier écrasé") from exc
            except OSError as exc:
                raise RuntimeError(f"{old.name} non déplacé — fichier conservé") from exc
            linked.append((old, new))
        for old, _new in linked:
            os.unlink(old)
    except Exception:
        for old, new in linked:
            if old.exists() and new.exists():
                try:
                    new.unlink()
                except OSError:
                    pass
        raise
    return dest_dir


def path_lock(path: Path | str) -> threading.RLock:
    try:
        key = str(Path(path).resolve())
    except OSError:
        key = str(Path(path))
    with _GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.RLock()
            _LOCKS[key] = lock
        return lock


def write_json_atomic(path: Path | str, data: Any, *, verify_existing: bool = True, compact: bool = False) -> None:
    """Replace ``path`` with JSON ``data``.

    Raises RuntimeError when the current file exists but is not a JSON object
    or array — the bytes on disk are preserved.
    """
    # verify_existing=False: caller just parsed + validated the file itself;
    # skip the re-parse (temp + fsync + os.replace unchanged).
    dest = Path(path)
    lock = path_lock(dest)
    with lock:
        if verify_existing and dest.is_file():
            try:
                existing = json.loads(dest.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as e:
                raise RuntimeError(f"{dest.name} illisible — fichier conservé") from e
            if not isinstance(existing, (dict, list)):
                raise RuntimeError(f"{dest.name} illisible — fichier conservé")
        if compact:
            text = json.dumps(data, ensure_ascii=False, allow_nan=False, separators=(",", ":")) + "\n"
        else:
            text = json.dumps(data, ensure_ascii=False, allow_nan=False, indent=2) + "\n"
        # Same directory as dest, unique private temp file (0o600 on POSIX) before os.replace.
        for anc in (dest.parent, *dest.parent.parents):
            if anc.is_symlink():
                raise RuntimeError(f"{anc.name} est un lien symbolique — écriture refusée")
        dest.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        for anc in (dest.parent, *dest.parent.parents):
            if anc.is_symlink():
                raise RuntimeError(f"{anc.name} est un lien symbolique — écriture refusée")
        if os.name == "posix" and dest.parent.name in (".hq-agent-state", ".hq-print3d"):
            try:
                os.chmod(dest.parent, 0o700)
            except OSError:
                pass
        fd, tmp_name = tempfile.mkstemp(prefix=f".{dest.name}.", suffix=".tmp", dir=str(dest.parent))
        tmp = Path(tmp_name)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(text)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, dest)
        except Exception:
            try:
                tmp.unlink()
            except OSError:
                pass
            raise
