"""Run one ACE-Step job inside its isolated Python environment."""
import json, os, sys, time, traceback, subprocess, threading
from pathlib import Path

ace, out = Path(sys.argv[1]), Path(sys.argv[2])
result_path = out / 'result.json'
def finish(result):
    tmp = out / 'result.tmp'
    tmp.write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    os.replace(tmp, result_path)
try:
    # The byte-range lock prevents overlapping workers even across HQ restarts.
    import msvcrt
    lock = (out.parent / 'worker.lock').open('a+b')
    lock.seek(0)
    try:
        msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
    except OSError:
        raise RuntimeError('Une autre génération Studio est déjà en cours')
    import psutil
    def memory_guard():
        low = 0
        while True:
            time.sleep(1)
            low = low + 1 if psutil.virtual_memory().available < 1200 * 1024 * 1024 else 0
            if low >= 3:
                finish({'status':'failed', 'error':'Mémoire disponible insuffisante; génération arrêtée.'})
                os._exit(90)
    threading.Thread(target=memory_guard, daemon=True).start()
    from acestep.handler import AceStepHandler
    from acestep.llm_inference import LLMHandler
    from acestep.inference import GenerationParams, GenerationConfig, generate_music
    import soundfile as sf
    import numpy as np
    job = json.loads((out / 'job.json').read_text(encoding='utf-8'))
    start = time.perf_counter()
    dit = AceStepHandler()
    status, ok = dit.initialize_service(project_root=str(ace), config_path='acestep-v15-turbo', device='cuda', offload_to_cpu=True, offload_dit_to_cpu=True, quantization='int8_weight_only')
    if not ok:
        raise RuntimeError(status)
    lm = LLMHandler()
    status, ok = lm.initialize(checkpoint_dir=str(ace / 'checkpoints'), lm_model_path='acestep-5Hz-lm-0.6B', backend='pt', device='cuda', offload_to_cpu=True, dtype=None)
    if not ok:
        raise RuntimeError(status)
    task = job.get('task', 'text2music')
    variants = int(job.get('variants') or 1)
    extra = {}
    if task != 'text2music':
        src = Path(job['src_audio'])
        # The server validated this path; refuse anything outside the Studio folder or redirected.
        if src.is_symlink() or out.parent.resolve() not in src.resolve().parents:
            raise RuntimeError('Création source invalide')
        extra['src_audio'] = str(src)
        if task == 'cover':
            extra.update(task_type='cover', audio_cover_strength=float(job['strength']))
        else:  # repaint and extend (outpaint past the end)
            extra.update(task_type='repaint', repainting_start=float(job['start']),
                         repainting_end=float(job['end']), chunk_mask_mode='explicit')
    params = GenerationParams(caption=job['prompt'], lyrics=job['lyrics'] or '[Instrumental]', instrumental=not bool(job['lyrics'].strip()), vocal_language=job['language'], bpm=job.get('bpm'), duration=job['duration'], inference_steps=8, seed=job['seed'], thinking=task == 'text2music', use_cot_caption=False, use_cot_metas=False, use_cot_language=False, **extra)
    config = GenerationConfig(batch_size=variants, audio_format='wav', use_random_seed=False, seeds=[(job['seed'] + i) % 2147483648 for i in range(variants)])
    result = generate_music(dit, lm, params=params, config=config, save_dir=str(out))
    if not result.success or not result.audios:
        raise RuntimeError(str(result.status_message))
    ready, seeds, audio_duration, sr, channels = 0, [], 0, 0, 0
    for n, entry in enumerate(result.audios[:variants], start=1):
        wav = Path(entry['path'])
        data, rate = sf.read(str(wav), always_2d=True)
        if not np.isfinite(data).all() or float(np.max(np.abs(data))) < 0.00001:
            if n == 1:
                raise RuntimeError('Audio vide ou invalide')
            continue
        length = len(data) / rate
        if task == 'text2music' and abs(length - job['duration']) > 2:
            raise RuntimeError('Durée audio inattendue')
        if task != 'text2music' and length < 5:
            raise RuntimeError('Audio remixé trop court')
        name = 'song.mp3' if ready == 0 else f'song-{ready + 1}.mp3'
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(wav), '-codec:a', 'libmp3lame', '-q:a', '2', str(out / name)], check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        subprocess.run(['ffmpeg', '-v', 'error', '-i', str(out / name), '-f', 'null', '-'], check=True, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        if ready == 0:
            audio_duration, sr, channels = length, rate, data.shape[1]
        ready += 1
        seed = entry.get('params', {}).get('seed') if isinstance(entry.get('params'), dict) else None
        seeds.append(seed if isinstance(seed, int) else job['seed'])
    finish({'status':'completed', 'duration_seconds':audio_duration, 'elapsed_seconds':round(time.perf_counter()-start, 2), 'sample_rate':sr, 'channels':channels, 'variants_ready':ready, 'seeds':seeds})
except Exception as exc:
    traceback.print_exc()
    finish({'status':'failed', 'error':str(exc)[:500]})
    sys.exit(1)
