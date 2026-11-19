"""One temporary state root for the assistant personhood, visit and relationship stores.

``hq_personhood``, ``hq_assistant_visits`` and ``hq_relationships`` resolve their
files through the bound feature module, then through ``hq_state.state_root()``,
whose fallback is the working directory; ``hq_companion_memory`` falls back to
``Path(".")``. A test that never binds therefore writes ``*_self.json``,
``*_visits.json`` and ``.hq-ai/...`` into the live checkout. ``set_up`` binds
every store the assistant suite can reach to one temporary directory::

    from tests import hq_assistant_state

    setUpModule = hq_assistant_state.set_up
    tearDownModule = hq_assistant_state.tear_down

A test that binds per test calls ``guard(self)`` instead: it snapshots the
checkout's store files and fails the test if any of them was created or rewritten
while it ran. ``assert_stores_bound(root)`` is the read-side check: it names every
store that still resolves somewhere other than the test's root.

Under pytest the checks are not opt-in: ``conftest.py`` arms
``tests/hq_store_guard.py``, which hooks the real store read/write paths and fails
the test that touches the checkout even when the module uses none of the above.
"""
import atexit
import os
import shutil
import sys
import tempfile
from pathlib import Path

import hq_state

# The checkout itself: an assistant store resolving here is unbound, and a test
# that reaches it reads the Master's real data or writes over it.
LIVE_ROOT = Path(__file__).resolve().parent.parent

# Store files that live inside the checkout. Only these are watched, so the guard
# never accuses a test that writes a fixture of its own somewhere else.
LIVE_STORE_DIRS = (".hq-ai", ".hq-household", ".hq-engine", ".hq-print3d",
                   ".hq-security", ".hq-inventoria", ".hq-agent-state")
LIVE_STORE_NAMES = ("*_self.json", "*_visits.json", "*_growth.json",
                    "*_thread.json", "*_visit_telemetry.json")

_ROOT: Path | None = None
_SAVED: dict = {}

# Live store paths this process wrote. A change made by another process — the
# running bridge appends its ambient persona visits every few minutes — must
# never be blamed on the test run, or the guard fails every gate on the Master's
# own activity.
_LIVE_WRITES: dict[str, int] = {}  # live store path -> writes made by this process
_WRITE_WATCH: list[bool] = []


def _stores():
    import hq_companion_memory as memory
    import hq_assistant_visits as visits
    import hq_culinia
    import hq_forgia
    import hq_inventoria
    import hq_musica
    import hq_pistonia_store
    import hq_securia
    import hq_elsea
    return (memory, hq_culinia, hq_forgia, hq_inventoria, hq_musica, hq_pistonia_store,
            hq_securia, hq_elsea, visits)


def _module_root(module) -> Path:
    """The root a store module would read and write right now.

    ``Path(".")`` is the modules' "never bound" placeholder — ``hq_relationships``
    and ``hq_companion_memory`` both start there — so it means "fall back to
    ``hq_state``", exactly as their own readers do.
    """
    for attr in ("_bound_root", "_root", "_telemetry_root"):
        value = getattr(module, attr, None)
        # Some modules expose ``_root`` as a helper function, not a root.
        if isinstance(value, (str, Path)) and str(value) not in ("", "."):
            return Path(value)
    callbacks = getattr(module, "_cb", None)
    if isinstance(callbacks, dict):
        root = callbacks.get("root")
        if isinstance(root, (str, Path)) and str(root) not in ("", "."):
            return Path(root)
    return hq_state.state_root()


def store_roots() -> dict[str, Path]:
    """Where every assistant store currently resolves, by label.

    ``hq_state`` is the fallback they all share, so it is listed too: a store with
    no binding of its own silently uses it.
    """
    memory, culinia, forgia, inventoria, musica, pistonia_store, securia, elsea, visits = _stores()
    import hq_relationships as relationships
    modules = {
        "memory": memory,
        "relationships": relationships,
        "inventoria": inventoria,
        "pistonia_store": pistonia_store,
        "culinia": culinia,
        "forgia": forgia,
        "musica": musica,
        "securia": securia,
        "elsea": elsea,
        "visits": visits,
    }
    roots = {label: _module_root(module) for label, module in modules.items()}
    roots["hq_state"] = hq_state.state_root()
    return roots


def _resolved(path: Path) -> Path:
    try:
        return Path(path).resolve()
    except OSError:
        return Path(path).absolute()


def _store_relative(path) -> str | None:
    """The checkout-relative path when ``path`` is inside one of its store folders."""
    try:
        resolved = Path(os.fspath(path)).resolve()
    except (TypeError, ValueError, OSError):
        return None
    try:
        relative = resolved.relative_to(LIVE_ROOT)
    except ValueError:
        return None
    parts = relative.parts
    if len(parts) < 2 or parts[0] not in LIVE_STORE_DIRS:
        return None
    return relative.as_posix()


def _audit_write(event, args) -> None:
    """Record the live store files this process writes; never raise into the caller."""
    try:
        if event == "open":
            path, mode, flags = args
            if isinstance(mode, str):
                writing = any(flag in mode for flag in "wax+")
            else:
                writing = bool((flags or 0) & (os.O_WRONLY | os.O_RDWR | os.O_CREAT
                                               | os.O_TRUNC | os.O_APPEND))
            if not writing:
                return
        elif event in ("os.replace", "os.rename"):
            path = args[1]
        elif event in ("os.remove", "os.unlink"):
            path = args[0]
        else:
            return
        # Cheap pre-filters: an audit hook runs on every open in the process, so a
        # path is resolved only when it can name the checkout's own ``.hq-*``
        # folders. Tests write ``.hq-*`` folders in their temp roots constantly.
        text = os.fspath(path)
        if ".hq" not in text:
            return
        if os.path.isabs(text) and not os.path.normcase(text).startswith(
                os.path.normcase(str(LIVE_ROOT) + os.sep)):
            return
        relative = _store_relative(path)
        if relative is not None:
            _LIVE_WRITES[relative] = _LIVE_WRITES.get(relative, 0) + 1
    except Exception:  # noqa: BLE001 — an audit hook must never break the caller
        pass


def _watch_writes() -> None:
    """Attribute every live store write to this process, once per interpreter."""
    if _WRITE_WATCH:
        return
    _WRITE_WATCH.append(True)
    sys.addaudithook(_audit_write)


def unbound_stores(*allowed: Path | str | None) -> dict[str, Path]:
    """Stores still pointing at the checkout, or outside the roots ``allowed``.

    A store under none of the allowed roots is not bound to this test either, so
    it reads another test's data. ``allowed`` empty means "only reject the
    checkout".
    """
    bases = [_resolved(entry) for entry in allowed if entry is not None]
    bad: dict[str, Path] = {}
    for label, root in store_roots().items():
        resolved = _resolved(root)
        if resolved == _resolved(LIVE_ROOT):
            bad[label] = root
        elif bases and not any(resolved == base or base in resolved.parents for base in bases):
            bad[label] = root
    return bad


def assert_stores_bound(*allowed: Path | str | None, context: str = "") -> None:
    """Fail loudly when a store would read or write the live checkout.

    Call it in ``setUp`` (every store must sit under this test's root) or in a
    cleanup (it must at least not be the checkout).
    """
    bad = unbound_stores(*allowed)
    if not bad:
        return
    detail = ", ".join(f"{label} -> {root}" for label, root in sorted(bad.items()))
    where = f" ({context})" if context else ""
    raise AssertionError(
        "assistant stores are not bound to this test" + where + ": " + detail
        + ". Bind them first — tests.hq_assistant_state.set_up()/bind(root) in setUp, "
          "or the module's own bind call — because an unbound store reads and writes "
        + str(LIVE_ROOT) + ", so the test either sees another module's data or the "
          "Master's real state.")


def live_store_files() -> dict[str, tuple[int, int]]:
    """Every assistant-store file in the checkout, keyed by path -> (mtime_ns, size)."""
    found: dict[str, tuple[int, int]] = {}
    for directory in LIVE_STORE_DIRS:
        base = LIVE_ROOT / directory
        if not base.is_dir():
            continue
        for pattern in LIVE_STORE_NAMES:
            for path in base.rglob(pattern):
                try:
                    stat = path.stat()
                except OSError:
                    continue
                found[path.relative_to(LIVE_ROOT).as_posix()] = (stat.st_mtime_ns, stat.st_size)
    return found


def assert_live_untouched(before: dict[str, tuple[int, int]], *, context: str = "",
                          since: dict[str, int] | None = None) -> None:
    """Fail loudly when this process wrote into the checkout's stores.

    Only files this process wrote count: the live bridge appends its ambient
    visits to the same stores while the gate runs, and that is not a test leak.
    """
    after = live_store_files()
    seen = since or {}
    ours = {name for name, count in _LIVE_WRITES.items() if count > seen.get(name, 0)}
    changed = sorted(name for name, stamp in after.items()
                     if before.get(name) != stamp and name in ours)
    if not changed:
        return
    shown = ", ".join(changed[:6]) + (" …" if len(changed) > 6 else "")
    where = f" ({context})" if context else ""
    raise AssertionError(
        "an assistant test wrote the live checkout" + where + ": " + shown
        + ". Its store was unbound and resolved to " + str(LIVE_ROOT)
        + "; bind it to a temporary root (set_up(), bind(root) or guard(case)) first.")


def guard(case) -> None:
    """Fail the test if it writes the checkout's stores while it runs.

    For modules that bind per test — their root is per test, so the module hooks
    below cannot see it: ``hq_assistant_state.guard(self)`` in ``setUp``.
    """
    _watch_writes()
    before = live_store_files()
    since = dict(_LIVE_WRITES)
    case.addCleanup(assert_live_untouched, before,
                    context=getattr(case, "_testMethodName", "test"), since=since)


def watch_live_checkout() -> None:
    """Name at interpreter exit the checkout's stores a test run wrote.

    ``tests/__init__.py`` arms this for every run, so a module that neither binds
    nor calls ``guard`` still reports the files it damaged.
    """
    _watch_writes()
    before = live_store_files()
    since = dict(_LIVE_WRITES)

    def report() -> None:
        guard = sys.modules.get("tests.hq_store_guard")
        if guard is not None and getattr(guard, "_armed", False):
            return  # the pytest guard already failed the run and named the test
        try:
            assert_live_untouched(before, context="end of test run", since=since)
        except AssertionError as exc:
            sys.stderr.write("\nASSISTANT STORE GUARD: " + str(exc) + "\n\n")

    atexit.register(report)


def bind(root: Path | str) -> None:
    """Point every assistant store at ``root``; no directory is created here."""
    memory, culinia, forgia, inventoria, musica, pistonia_store, securia, elsea, visits = _stores()
    path = Path(root)
    hq_state.bind_root(path)
    visits.bind_state_root(path)  # the visit telemetry file, without dropping its providers
    memory.bind(root=path, now=memory._now)
    inventoria.bind(root=path)
    pistonia_store.bind(path)
    for module in (culinia, forgia, musica, securia, elsea):
        module.bind(root=path)


def set_up() -> Path:
    """Bind every assistant store to one fresh temporary root and return it."""
    global _ROOT
    if _ROOT is not None:
        return _ROOT
    memory, culinia, forgia, inventoria, musica, pistonia_store, securia, elsea, visits = _stores()
    _ROOT = Path(tempfile.mkdtemp(prefix="hq-assistant-state-"))
    _watch_writes()
    # One snapshot per module run: a test that writes the checkout fails the
    # module loudly instead of quietly rewriting the Master's stores.
    _SAVED.update({
        "live": live_store_files(),
        "writes": dict(_LIVE_WRITES),
        "state_root": hq_state._STATE_ROOT.get(),
        "visits_root": visits._telemetry_root,
        "memory": (memory._root, memory._now),
        "inventoria": dict(inventoria._cb),
        "pistonia": pistonia_store._root,
        "roots": {module.__name__: getattr(module, "_bound_root", None)
                  for module in (culinia, forgia, musica, securia, elsea)},
    })
    bind(_ROOT)
    assert_stores_bound(_ROOT, context="set_up")  # every store must sit under this root
    atexit.register(tear_down, check=False)
    return _ROOT


def tear_down(*, check: bool = True) -> None:
    """Put the previous bindings back and delete the temporary root.

    ``check`` fails the module when the run wrote the checkout's stores; the
    atexit copy passes ``False`` so a failure already reported is not repeated.
    """
    try:
        if check:
            assert_live_untouched(_SAVED.get("live") or {}, context="tear_down",
                                  since=_SAVED.get("writes") or {})
    finally:
        _restore()


def _restore() -> None:
    global _ROOT
    if _ROOT is None:
        return
    memory, culinia, forgia, inventoria, musica, pistonia_store, securia, elsea, visits = _stores()
    # hq_relationships has no binding of its own: it follows hq_state again.
    hq_state.bind_root(_SAVED.get("state_root"))
    visits.bind_state_root(_SAVED.get("visits_root"))
    saved_root, saved_now = _SAVED["memory"]
    memory._root, memory._now = saved_root, saved_now
    inventoria._cb.clear()
    inventoria._cb.update(_SAVED["inventoria"])
    pistonia_store._root = _SAVED["pistonia"]
    for module in (culinia, forgia, musica, securia, elsea):
        module._bound_root = _SAVED["roots"][module.__name__]
    shutil.rmtree(_ROOT, ignore_errors=True)
    _ROOT = None
