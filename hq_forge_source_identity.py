"""Reviewed source identity for the exact-port launcher and recovery schema.

The approved baseline is the infrastructure checkpoint commit. The approved
tree is a Git tree id of that checkpoint plus the reviewed maintenance
corrections. Before the tree is hashed, the assignment of this tree id is
replaced with the placeholder ``<approved-tree>``. The id therefore does not
depend on the commit that records these bytes, and it can be known before
that commit exists.
"""

from __future__ import annotations

import os
import re
import subprocess
import tempfile
from pathlib import Path

APPROVED_BASELINE = "7fb650bb4097c789cc2027164f20a7b44cfe99c2"
APPROVED_TREE = "ecd5d4617427a92367f1022a408dabb358bb91b8"
IDENTITY_PATH = "hq_forge_source_identity.py"
PUBLICATION_PATH = "tests/m2b_publication.py"
_ASSIGNMENT = re.compile(rb'^APPROVED_TREE = "(?:[0-9a-f]{40}|<approved-tree>)"$', re.MULTILINE)


class IdentityError(RuntimeError):
    pass


def _git(root: Path, args: list[str], *, index: Path | None = None, stdin: bytes | None = None) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if index is None:
        env.pop("GIT_INDEX_FILE", None)
    else:
        env["GIT_INDEX_FILE"] = str(index)
    return subprocess.run(
        ["git", "-C", str(root), *args],
        check=False,
        capture_output=True,
        input=stdin,
        env=env,
    )


def normalize_identity(data: bytes) -> bytes:
    text = data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    updated, count = _ASSIGNMENT.subn(b'APPROVED_TREE = "<approved-tree>"', text, count=1)
    if count != 1:
        raise IdentityError("checkout identity mismatch")
    return updated


def _status_paths(root: Path) -> list[tuple[str, str]]:
    completed = _git(root, ["status", "--porcelain", "-z"])
    if completed.returncode != 0:
        raise IdentityError("checkout identity mismatch")
    found: list[tuple[str, str]] = []
    entries = completed.stdout.split(b"\0")
    skip_next = False
    for entry in entries:
        if not entry:
            continue
        if skip_next:
            skip_next = False
            continue
        code = entry[:2].decode("ascii", errors="replace")
        if code[:1] in {"R", "C"} or code[1:2] in {"R", "C"}:
            skip_next = True
        path = entry[3:].decode("utf-8")
        found.append((code, path.replace("\\", "/")))
    return found


def reviewed_tree(root: Path) -> str:
    """Return the normalized tree id of the worktree that would be committed."""
    source = Path(root).resolve()
    identity = source / IDENTITY_PATH
    if not identity.is_file():
        raise IdentityError("checkout identity mismatch")
    descriptor, name = tempfile.mkstemp(prefix="m2b-tree-")
    os.close(descriptor)
    index = Path(name)
    try:
        read = _git(source, ["read-tree", "HEAD"], index=index)
        if read.returncode != 0:
            raise IdentityError("checkout identity mismatch")
        for code, path in _status_paths(source):
            if path == IDENTITY_PATH:
                continue
            tracked_change = code.strip() != "" and not code.startswith("?")
            publication = code == "??" and path == PUBLICATION_PATH
            if not tracked_change and not publication:
                continue
            added = _git(source, ["add", "--", path], index=index)
            if added.returncode != 0:
                raise IdentityError("checkout identity mismatch")
        blob = _git(
            source,
            ["hash-object", "-w", "--path", IDENTITY_PATH, "--stdin"],
            stdin=normalize_identity(identity.read_bytes()),
        )
        if blob.returncode != 0:
            raise IdentityError("checkout identity mismatch")
        digest = blob.stdout.decode("ascii").strip()
        updated = _git(source, ["update-index", "--add", "--cacheinfo", f"100644,{digest},{IDENTITY_PATH}"], index=index)
        if updated.returncode != 0:
            raise IdentityError("checkout identity mismatch")
        tree = _git(source, ["write-tree"], index=index)
        if tree.returncode != 0:
            raise IdentityError("checkout identity mismatch")
        return tree.stdout.decode("ascii").strip()
    finally:
        index.unlink(missing_ok=True)


def assert_reviewed_source(root: Path, *, baseline: str, tree: str, fixed: bool) -> dict:
    """Accept a clean or dirty worktree only when its normalized tree is approved."""
    source = Path(root).resolve()
    head = _git(source, ["rev-parse", "HEAD"])
    ancestor = _git(source, ["merge-base", "--is-ancestor", baseline, "HEAD"])
    if head.returncode != 0 or ancestor.returncode != 0:
        raise IdentityError("checkout identity mismatch")
    actual = reviewed_tree(source)
    if actual != tree:
        raise IdentityError("checkout identity mismatch")
    status = _git(source, ["status", "--porcelain"])
    if status.returncode != 0:
        raise IdentityError("checkout identity mismatch")
    clean = status.stdout.strip() == b""
    if fixed and not clean:
        raise IdentityError("fixed page port requires a clean reviewed tree")
    return {
        "head": head.stdout.decode("ascii").strip(),
        "baseline": baseline,
        "tree": actual,
        "clean": clean,
    }
