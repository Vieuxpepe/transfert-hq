"""Local ACE-Step studio jobs. All requests are authenticated by the HQ bridge."""
from __future__ import annotations
import json
import os
import shutil
from pathlib import Path
import re
import subprocess
import threading
import time
import uuid

_lock = threading.Lock()
_active = None
_ID = re.compile(r"^[0-9a-f]{32}$")
MAX_VARIANTS = 3
TASKS = ('text2music', 'repaint', 'cover', 'extend')

class StudioError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status

def _base(root):
    base = Path(root) / '.hq-music' / 'studio'
    if any(p.is_symlink() or (hasattr(os, 'isjunction') and os.isjunction(p)) for p in (base.parent, base)):
        raise StudioError('Emplacement Studio redirigé', 503)
    return base

def _job_dir(root, job_id):
    if not isinstance(job_id, str) or not _ID.fullmatch(job_id):
        raise StudioError('Identifiant invalide')
    path = _base(root) / job_id
    if path.is_symlink() or (hasattr(os, 'isjunction') and os.isjunction(path)):
        raise StudioError('Emplacement Studio redirigé', 503)
    return path

def _write_json(path, value):
    tmp = path.with_name(path.name + '.tmp')
    with tmp.open('w', encoding='utf-8') as handle:
        handle.write(json.dumps(value, ensure_ascii=False))
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)

def _status(root, job_id):
    path = _job_dir(root, job_id)
    try:
        obj = json.loads((path / 'job.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise StudioError('Création introuvable', 404)
    result = path / 'result.json'
    if result.is_file() and not result.is_symlink():
        try:
            obj.update(json.loads(result.read_text(encoding='utf-8')))
        except (OSError, ValueError):
            pass
    elif obj.get('status') == 'running' and _active is not None and _active.poll() is not None:
        obj.update(status='failed', error='Le processus de génération s’est arrêté.')
    obj.pop('src_audio', None)  # server-side path; the UI uses source_id
    if obj.get('status') == 'completed':
        obj['audio_url'] = '/api/music/studio/audio/' + job_id
        variants = obj.get('variants_ready') if isinstance(obj.get('variants_ready'), int) else 1
        if variants > 1 and not obj.get('picked'):
            obj['variant_urls'] = ['/api/music/studio/audio/' + job_id + ('' if n == 1 else f'.{n}')
                                   for n in range(1, variants + 1)]
    return obj

def list_jobs(root, *, include_jingles=False):
    base = _base(root)
    jobs = []
    if base.is_dir():
        for path in sorted(base.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True):
            if len(jobs) >= 30:
                break
            if _ID.fullmatch(path.name):
                try:
                    job = _status(root, path.name)
                except StudioError:
                    continue
                if job.get('jingle') and not include_jingles:
                    continue
                jobs.append(job)
    return jobs

def _variant_name(n):
    return 'song.mp3' if n == 1 else f'song-{n}.mp3'

def audio_path(root, token):
    """``<id>`` serves the main take; ``<id>.<n>`` serves variant n (2–3) before a pick."""
    job_id, _, variant = str(token or '').partition('.')
    n = 1
    if variant:
        if variant not in ('2', '3'):
            raise StudioError('Variante invalide')
        n = int(variant)
    job = _status(root, job_id)
    path = _job_dir(root, job_id) / _variant_name(n)
    if job.get('status') != 'completed' or not path.is_file() or path.is_symlink():
        raise StudioError('Audio introuvable', 404)
    return path

def _trash_dir(root):
    trash = _base(root).parent / 'studio-trash'
    if trash.is_symlink() or (hasattr(os, 'isjunction') and os.isjunction(trash)):
        raise StudioError('Corbeille Studio redirigée', 503)
    trash.mkdir(parents=True, exist_ok=True)
    return trash

def pick(root, job_id, variant):
    """Keep variant ``variant`` as the take; move the others to the local Studio trash."""
    if type(variant) is not int or not 1 <= variant <= MAX_VARIANTS:
        raise StudioError('Variante invalide')
    with _lock:
        job = _status(root, job_id)
        count = job.get('variants_ready') if isinstance(job.get('variants_ready'), int) else 1
        if job.get('status') != 'completed' or count < 2 or job.get('picked'):
            raise StudioError('Aucun choix de variante en attente', 409)
        if variant > count:
            raise StudioError('Variante invalide')
        folder = _job_dir(root, job_id)
        trash = _trash_dir(root)
        chosen = folder / _variant_name(variant)
        if not chosen.is_file() or chosen.is_symlink():
            raise StudioError('Audio introuvable', 404)
        if variant != 1:
            os.replace(folder / 'song.mp3', trash / f'{job_id}-v1.mp3')
            os.replace(chosen, folder / 'song.mp3')
        for n in range(2, count + 1):
            other = folder / _variant_name(n)
            if n != variant and other.is_file() and not other.is_symlink():
                os.replace(other, trash / f'{job_id}-v{n}.mp3')
        meta = json.loads((folder / 'job.json').read_text(encoding='utf-8'))
        meta['picked'] = variant
        seeds = job.get('seeds')  # written by the worker into result.json
        if isinstance(seeds, list) and len(seeds) >= variant and isinstance(seeds[variant - 1], int):
            meta['seed'] = seeds[variant - 1]
        _write_json(folder / 'job.json', meta)
        return _status(root, job_id)

_SAFE_NAME = re.compile(r'[^\w\- ]+', re.UNICODE)

def copy_to_library(root, job_id):
    """Copy a finished take into Inbox/Musica Studio: the Lecteur lists it and the iPhone sees it in Fichiers."""
    job = _status(root, job_id)
    source = audio_path(root, job_id)
    inbox = Path(root) / 'Inbox'
    folder = inbox / 'Musica Studio'
    for p in (inbox, folder):
        if p.is_symlink() or (hasattr(os, 'isjunction') and os.isjunction(p)):
            raise StudioError('Dossier de bibliothèque redirigé', 503)
    folder.mkdir(parents=True, exist_ok=True)
    title = (job.get('gift') or {}).get('title') or job.get('title') or job.get('prompt') or 'Création'
    stem = ' '.join(_SAFE_NAME.sub(' ', str(title)).split())[:60].strip() or 'Création'
    name = f'{stem} - {job_id[:6]}.mp3'
    dest = folder / name
    if dest.is_symlink():
        raise StudioError('Destination redirigée', 503)
    if not dest.exists():
        tmp = folder / (name + '.partial')
        shutil.copyfile(source, tmp)
        os.replace(tmp, dest)
    return {'name': name, 'rel': f'Inbox/Musica Studio/{name}', 'title': stem}

def delete(root, job_id):
    """Remove a finished take from the Studio list into a recoverable local trash."""
    with _lock:
        source = _job_dir(root, job_id)
        job = _status(root, job_id)
        # A result file is written only when the worker reaches a terminal state.
        # Do not rely on the process-local _active pointer after an HQ restart.
        result = source / 'result.json'
        if not result.is_file() or result.is_symlink():
            raise StudioError('Génération encore en cours', 409)
        try:
            terminal = json.loads(result.read_text(encoding='utf-8')).get('status')
        except (OSError, ValueError, AttributeError) as exc:
            raise StudioError('État de génération illisible', 409) from exc
        if terminal not in ('completed', 'failed') or job.get('status') not in ('completed', 'failed'):
            raise StudioError('Génération encore en cours', 409)
        trash = _trash_dir(root)
        destination = trash / job_id
        if destination.exists() or destination.is_symlink():
            raise StudioError('Cette création existe déjà dans la corbeille', 409)
        try:
            os.rename(source, destination)
        except OSError as exc:
            raise StudioError('Impossible de déplacer la création dans la corbeille', 503) from exc
        return {'id': job_id, 'trashed': True}

def start(root, body, *, gift=None, jingle=None):
    global _active
    if not isinstance(body, dict):
        raise StudioError('Corps invalide')
    prompt, lyrics = body.get('prompt'), body.get('lyrics', '')
    if not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 512:
        raise StudioError('Prompt requis (1–512 caractères)')
    if not isinstance(lyrics, str) or len(lyrics) > 4096:
        raise StudioError('Paroles invalides (maximum 4096 caractères)')
    seed, duration = body.get('seed', 42), body.get('duration', 90)
    if type(seed) is not int or not 0 <= seed <= 2147483647:
        raise StudioError('Seed invalide')
    if type(duration) is not int or not 10 <= duration <= 120:
        raise StudioError('Durée invalide (10–120 secondes)')
    bpm = body.get('bpm')
    if bpm is not None and (type(bpm) is not int or not 30 <= bpm <= 300):
        raise StudioError('Tempo invalide (30–300 BPM)')
    language = body.get('language', 'en')
    if language not in ('en', 'fr', 'unknown'):
        raise StudioError('Langue invalide')
    task = body.get('task', 'text2music')
    if task not in TASKS:
        raise StudioError('Tâche Studio invalide')
    variants = body.get('variants', 1)
    if type(variants) is not int or not 1 <= variants <= MAX_VARIANTS:
        raise StudioError('Nombre de variantes invalide (1–3)')
    remix = {}
    if task != 'text2music':
        parent = _status(root, body.get('source_id'))
        if parent.get('status') != 'completed':
            raise StudioError('La création source doit être terminée', 409)
        src = audio_path(root, parent['id'])
        src_duration = float(parent.get('duration_seconds') or parent.get('duration') or 0)
        if src_duration <= 0:
            raise StudioError('Durée de la création source inconnue', 409)
        remix = {'source_id': parent['id'], 'src_audio': str(src), 'src_duration': round(src_duration, 2)}
        if task == 'repaint':
            start_s, end_s = body.get('start'), body.get('end')
            if not all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in (start_s, end_s)):
                raise StudioError('Début et fin du passage requis')
            if not 0 <= start_s < end_s <= src_duration + 0.5 or end_s - start_s < 2:
                raise StudioError('Passage invalide (2 s minimum, dans la durée du morceau)')
            remix.update(start=round(float(start_s), 2), end=round(float(end_s), 2))
            duration = int(round(src_duration))
        elif task == 'cover':
            strength = body.get('strength', 0.5)
            if not isinstance(strength, (int, float)) or isinstance(strength, bool) or not 0.1 <= strength <= 1:
                raise StudioError('Intensité invalide (0,1–1)')
            remix['strength'] = round(float(strength), 2)
            duration = int(round(src_duration))
        else:  # extend: repaint past the end (ACE-Step pads the source and outpaints)
            extra = body.get('extra', 30)
            if type(extra) is not int or not 10 <= extra <= 60:
                raise StudioError('Prolongation invalide (10–60 secondes)')
            if src_duration + extra > 180:
                raise StudioError('Durée finale maximale : 180 secondes')
            remix.update(start=round(max(0.0, src_duration - 2), 2), end=round(src_duration + extra, 2), extra=extra)
            duration = int(round(src_duration + extra))
        if not lyrics.strip() and parent.get('lyrics'):
            lyrics = parent['lyrics']
    if variants > 1 and duration * variants > 240:
        raise StudioError('Trop long pour plusieurs variantes (durée × variantes ≤ 240 s)')
    title = body.get('title')
    if title is not None and (not isinstance(title, str) or len(title) > 100):
        raise StudioError('Titre invalide')
    ace = Path(root) / 'ACE-Step-1.5'
    python = ace / '.venv' / 'Scripts' / 'python.exe'
    if not python.is_file():
        raise StudioError('Environnement ACE-Step introuvable', 503)
    with _lock:
        if _active is not None and _active.poll() is None:
            raise StudioError('Une génération est déjà en cours', 409)
        job_id = uuid.uuid4().hex
        job_dir = _job_dir(root, job_id)
        job_dir.mkdir(parents=True, exist_ok=False)
        job = {'id': job_id, 'status': 'running', 'prompt': prompt.strip(), 'lyrics': lyrics,
               'seed': seed, 'duration': duration, 'language': language, 'bpm': bpm,
               'task': task, 'variants': variants, 'created': time.time(), **remix}
        if title and title.strip():
            job['title'] = title.strip()
        if gift is not None:
            job['gift'] = gift
        if jingle is not None:
            job['jingle'] = jingle
        (job_dir / 'job.json').write_text(json.dumps(job, ensure_ascii=False), encoding='utf-8')
        try:
            with (job_dir / 'worker.log').open('w', encoding='utf-8') as log:
                _active = subprocess.Popen([str(python), str(Path(__file__).with_name('hq_music_studio_worker.py')),
                                            str(ace), str(job_dir)], cwd=str(ace), stdout=log,
                                           stderr=subprocess.STDOUT, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        except OSError as exc:
            (job_dir / 'result.json').write_text(json.dumps({'status':'failed', 'error': str(exc)}), encoding='utf-8')
            raise StudioError('Impossible de démarrer le Studio', 503) from exc
        process = _active
        def watch():
            process.wait()
            result_file = job_dir / 'result.json'
            if not result_file.exists():
                result_file.write_text(json.dumps({'status':'failed', 'error':'Le processus de génération s’est arrêté.'}, ensure_ascii=False), encoding='utf-8')
        threading.Thread(target=watch, daemon=True).start()
        return job
