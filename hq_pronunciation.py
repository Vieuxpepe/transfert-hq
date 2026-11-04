"""Optional local French/English phonemes for the companion's visual speech.

Gruut is optional. One worker retains its thread-local dictionaries; bounded
sentence caching avoids repeating pronunciation work for duplicated bubbles.
"""
from __future__ import annotations

import functools
import re
import unicodedata
import threading
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

_worker = ThreadPoolExecutor(max_workers=1, thread_name_prefix="hq-phonemes")
_pending = threading.BoundedSemaphore(6)
_external = None


def _external_plan(text: str, language: str) -> dict:
    """Reuse an installed compatible Python when the bridge uses a newer one.

    The child is local, hidden, and persistent; its stdin closes with the
    bridge, so it exits automatically. No standalone service or port is used.
    """
    global _external
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    if _external is None or _external.poll() is not None:
        candidates = [os.environ.get("HQ_PRONUNCIATION_PYTHON"), shutil.which("python"), shutil.which("python3")]
        executable = None
        for candidate in dict.fromkeys(candidates):
            if not candidate or os.path.normcase(os.path.realpath(candidate)) == os.path.normcase(os.path.realpath(sys.executable)):
                continue
            check = subprocess.run([candidate, "-c", "import gruut, gruut_lang_fr, gruut_lang_en"],
                                   capture_output=True, timeout=8, creationflags=flags)
            if check.returncode == 0:
                executable = candidate
                break
        if not executable:
            raise ImportError("No local pronunciation engine")
        _external = subprocess.Popen([executable, "-u", str(Path(__file__).resolve()), "--worker"],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     text=True, encoding="utf-8", creationflags=flags, close_fds=True)
    _external.stdin.write(json.dumps({"text": text, "language": language}) + "\n")
    _external.stdin.flush()
    result = json.loads(_external.stdout.readline())
    if "error" in result:
        raise RuntimeError("Local pronunciation failed")
    return result


def language_for(text: str, requested: str = "auto") -> str:
    if requested in ("fr", "fr-fr", "fr-ca"):
        return "fr-fr"
    if requested in ("en", "en-us", "en-gb"):
        return "en-us"
    words = set(re.findall(r"[a-zà-ÿ]+", text.lower()))
    french = len(words & set("je tu il elle nous vous ils elles le la les des du une un et est suis avec pour dans pas oui bonjour merci comment ça très bien mon ton ma ta mes tes que qui ne ce cette au aux".split()))
    english = len(words & set("i you he she we they the a an and is are am with for in not yes hello thanks how my your this that what why it to of can have do good".split()))
    return "en-us" if english > french else "fr-fr"


def phoneme_visemes(phoneme: str) -> list[str]:
    sound = "".join(c for c in unicodedata.normalize("NFD", phoneme)
                    if not unicodedata.combining(c) and c not in "ˈˌːˑ͜͡")
    result = []
    for char in sound:
        shape = ("M" if char in "pbm" else "F" if char in "fvʋ" else
                 "A" if char in "aɑɐæʌ" else "E" if char in "eɛəɜɞ" else
                 "I" if char in "iɪɨj" else "O" if char in "oɔɒ" else
                 "U" if char in "uʊyʏɯʉwɥøœɵ" else
                 "SH" if char in "ʃʒʂʐ" else "S" if char in "sz" else
                 "R" if char in "rɹɻʁʀɚɝ" else
                 "T" if char in "tdnŋɲɳlkɡgqcçxɣθðɫ" else None)
        if shape and (not result or result[-1] != shape):
            result.append(shape)
    return result


def _key(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFC", text).lower().replace("’", "'")
                   if c.isalpha() or c.isdigit() or c in "'-")


@functools.lru_cache(maxsize=256)
def _plan(text: str, language: str) -> dict:
    try:
        import gruut
    except ImportError:
        return _external_plan(text, language)

    context = [w for sentence in gruut.sentences(text, lang=language) for w in sentence
               if w.is_spoken and w.phonemes and _key(w.text)]
    words, cursor = [], 0
    for raw in re.findall(r"\S+", text):
        match = next((i for i in range(cursor, min(len(context), cursor + 16))
                      if _key(context[i].text) == _key(raw)), None)
        if not any(c.isalnum() for c in raw):
            phonemes = []
        elif match is not None:
            phonemes = list(context[match].phonemes)
            cursor = match + 1
        elif any(c.isalnum() for c in raw):
            # Number expansion and tokenization can change a displayed token.
            # Resolve that token locally rather than shifting later words.
            phonemes = [p for sentence in gruut.sentences(raw, lang=language)
                        for w in sentence if w.is_spoken for p in (w.phonemes or [])]
        else:
            phonemes = []
        shapes = []
        for phoneme in phonemes:
            for shape in phoneme_visemes(phoneme):
                if not shapes or shapes[-1] != shape:
                    shapes.append(shape)
        words.append({"text": raw, "phonemes": phonemes,
                      "visemes": shapes if shapes or not any(c.isalpha() for c in raw) else None})
    return {"engine": "gruut", "language": language, "text": text, "words": words}


def pronunciation(text: str, language: str = "auto") -> dict | None:
    text = str(text or "").strip()
    if not text or len(text) > 4000:
        return None
    if not _pending.acquire(blocking=False):
        return None
    try:
        future = _worker.submit(_plan, text, language_for(text, language))
    except Exception:
        _pending.release()
        return None
    future.add_done_callback(lambda _: _pending.release())
    try:
        return future.result(timeout=2.5)
    except Exception:
        # Missing models, unknown languages or a slow cold start must never
        # block chat or prevent the existing spelling fallback from working.
        return None


def enrich(response: dict, language: str = "auto") -> dict:
    if not isinstance(response, dict):
        return response
    text = response.get("reply") or response.get("line")
    if isinstance(text, str):
        plan = pronunciation(text, language)
        if plan:
            response = {**response, "pronunciation": plan}
    return response


def warmup() -> None:
    for text, language in (("Bonjour", "fr-fr"), ("Hello", "en-us")):
        _worker.submit(_plan, text, language)


if __name__ == "__main__" and "--worker" in sys.argv:
    for line in sys.stdin:
        try:
            request = json.loads(line)
            result = _plan(request["text"], request["language"])
        except Exception as exc:
            result = {"error": type(exc).__name__}
        print(json.dumps(result, ensure_ascii=True), flush=True)
