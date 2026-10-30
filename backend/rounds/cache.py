import asyncio
import contextlib
import hashlib
import json
import os
import shutil
import tempfile
import time
from pathlib import Path

from . import audio, bot, encode, pipeline, tags, ticker
from .config import JOBS_DIR

# [DOC: render-cache]
ENCODE_ONLY, ENCODE_OPTIONS = ('codec', 'denoise'), ('loudnorm', 'metadata')
FRAME_FACTS = ('rate', 'frames', 'upscale', 'synth', 'dupes', 'seams')
VERSIONS = 2
FRAMES, VOICE = 'frames', 'voice'
SUFFIX = {FRAMES: '.yuv', VOICE: '.wav'}
EVERY = '*/cache/*.json'
FIRST_SHARE = 0.35
CODE = hashlib.sha256(b''.join(p.read_bytes() for p in sorted(Path(__file__).parent.glob('*.py')))).hexdigest()


def digest(*parts) -> str:
    return hashlib.sha256(json.dumps([CODE, *parts], sort_keys=True).encode()).hexdigest()[:32]


def frames_key(request: dict) -> str:
    options = {k: v for k, v in request['options'].items() if k not in ENCODE_OPTIONS}
    return digest({**{k: v for k, v in request.items() if k not in ENCODE_ONLY}, 'options': options})


def voice_key(request: dict) -> str | None:
    return digest(request['start'], request['end'], request['denoise']) if request.get('denoise', 0) > 0 else None


def folder(job_dir: str) -> Path:
    return Path(job_dir, 'cache')


def card(job_dir: str, kind: str, key: str) -> Path:
    return folder(job_dir) / f'{kind}-{key}.json'


def read(path: Path) -> dict | None:
    with contextlib.suppress(OSError, ValueError):
        return json.loads(path.read_text())
    return None


def cards(root: Path, pattern: str) -> list[tuple[Path, dict]]:
    found = ((c, read(c)) for c in root.glob(pattern))
    return sorted(((c, e) for c, e in found if e), key=lambda pair: pair[1]['used'])


def drop(path: Path) -> None:
    for p in (path, *(path.with_suffix(s) for s in SUFFIX.values())):
        p.unlink(missing_ok=True)


def place(src, dst) -> None:
    try:
        os.link(src, dst)
    except OSError:
        os.symlink(src, dst)


def ready(job_dir: str, request: dict) -> bool:
    path = card(job_dir, FRAMES, frames_key(request))
    return path.exists() and path.with_suffix(SUFFIX[FRAMES]).exists()


def find(job_dir: str, kind: str, key: str) -> dict | None:
    path = card(job_dir, kind, key)
    entry, file = read(path), path.with_suffix(SUFFIX[kind])
    if not entry or not file.exists():
        return None
    entry['used'] = time.time()
    path.write_text(json.dumps(entry))
    return {**entry, 'path': str(file)}


# [DOC: render-cache]
def evict(budget: int) -> None:
    every = cards(Path(JOBS_DIR), EVERY)
    total = sum(e['size'] for _, e in every)
    for path, entry in every:
        if total <= budget:
            return
        drop(path)
        total -= entry['size']


def expire(ttl: float) -> int:
    old = [path for path, entry in cards(Path(JOBS_DIR), EVERY) if entry['used'] < time.time() - ttl]
    for path in old:
        drop(path)
    return len(old)


# [DOC: render-cache]
def older(job_dir: str, kind: str, user: int | None) -> list[Path]:
    if user is not None:
        return [path for path, entry in cards(Path(JOBS_DIR), f'*/cache/{kind}-*.json') if entry.get('user') == user]
    old = cards(folder(job_dir), f'{kind}-*.json')
    return [path for path, _ in old[: max(len(old) - VERSIONS + 1, 0)]]


def keep(job_dir: str, kind: str, key: str, file: Path, facts: dict, cap: int | None, user: int | None) -> None:
    for path in older(job_dir, kind, user):
        drop(path)
    size = file.stat().st_size
    if cap:
        evict(cap - size)
    path = card(job_dir, kind, key)
    shutil.move(file, path.with_suffix(SUFFIX[kind]))
    path.write_text(json.dumps({**facts, 'used': time.time(), 'size': size, 'user': user}))


def seed(job_dir: str, request: dict, work: str) -> None:
    if (key := voice_key(request)) and (hit := find(job_dir, VOICE, key)):
        done = audio.cleaned(work)
        done.parent.mkdir(exist_ok=True)
        place(hit['path'], done)


def store(job_dir: str, request: dict, work: str, result: dict, cap=None, user=None) -> None:
    folder(job_dir).mkdir(exist_ok=True)
    facts = {k: result[k] for k in FRAME_FACTS if k in result}
    made = (FRAMES, frames_key(request), Path(work, encode.RAW)), (VOICE, voice_key(request), audio.cleaned(work))
    for kind, key, file in made:
        if key and file.is_file() and not file.is_symlink() and not card(job_dir, kind, key).exists():
            keep(job_dir, kind, key, file, facts if kind == FRAMES else {}, cap, user)


def replay(job_dir: str, src, meta: dict, request: dict, frames: dict, out, progress=None, cap=None, user=None) -> dict:
    options = {**request['options'], 'denoise': request.get('denoise', 0)}
    rate, n, codec = frames['rate'], frames['frames'], request.get('codec', 'av1')
    first = progress and (lambda f: progress(FIRST_SHARE * f))
    tail = progress and (lambda f: progress(FIRST_SHARE + (1 - FIRST_SHARE) * f))
    with tempfile.TemporaryDirectory() as work:
        place(frames['path'], Path(work, encode.RAW))
        seed(job_dir, request, work)
        encode.replay(work, codec, rate, n / rate, n, meta['has_audio'], first)
        scale = encode.second_pass(work, src, meta, request['start'], n / rate, n, rate, out, options, codec, tail)
        store(job_dir, request, work, {}, cap, user)
    tags.write(out, tags.kept(meta, options))
    return {'size': Path(out).stat().st_size, 'duration': n / rate, 'rate': rate, 'frames': n, 'codec': codec,
            'fit': round(scale, 2)}  # fmt: skip


# [DOC: render-cache]
async def reuse(job: dict, jobs, volume, cap: int | None = None, user: int | None = None) -> bool:
    job_id, request, meta = job['id'], job['request'], job['meta']
    job_dir = f'{JOBS_DIR}/{job_id}'
    with contextlib.suppress(RuntimeError):  # open files of a prepare
        await volume.reload.aio()
    if not (frames := await asyncio.to_thread(find, job_dir, FRAMES, frames_key(request))):
        return False
    began = time.monotonic()
    pipeline.note(job_id, 'reuse.wait', pipeline.waited(job))
    try:
        src, out = f'{job_dir}/{job["source"]}', f'{job_dir}/note.mp4'
        async with bot.acting(job['chat_id'], 'record_video_note'), ticker.typing(job):
            job = await pipeline.stage(jobs, job, 'reusing')
            report = pipeline.reporter(job, 'reusing', asyncio.get_running_loop())
            with pipeline.timed(job_id, 'reuse.encode') as facts:
                args = job_dir, src, meta, request, frames, out, report, cap, user
                result = await asyncio.to_thread(replay, *args)
                facts.update(fps=(result['frames'], ''), mb=round(result['size'] / pipeline.MB, 1), fit=result['fit'])
            with pipeline.timed(job_id, 'reuse.commit'):
                await volume.commit.aio()
        await pipeline.send(jobs, job, out, result)
        pipeline.note(job_id, 'reuse', time.monotonic() - began, clip=round(result['duration'], 2))
    except Exception as error:
        await pipeline.fail(jobs, job, error)
    return True
