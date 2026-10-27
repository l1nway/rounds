import asyncio
import contextlib
import hashlib
import json
import os
import threading

import numpy as np

from . import media
from .config import FPS, JOBS_DIR
from .pipeline import note, reporter, stage, timed
from .transfer import held

WATCH = 3
SPAN = 'start', 'end', 'prompt'
STAGES = {'decode': 'decoding', 'track': 'tracking', 'cuts': 'cuts'}


class Superseded(Exception):
    pass


# [DOC: square-source]
def follows(meta: dict, request: dict) -> bool:
    square = meta['width'] == meta['height']
    return request['prompt']['time'] is not None and (not square or request['options'].get('zoom', False))


def key(job_id: str, prompt: dict) -> str:
    return f'track:{job_id}:' + hashlib.sha256(json.dumps(prompt, sort_keys=True).encode()).hexdigest()[:16]


def to_source(found: dict, frames: np.ndarray, meta: dict) -> dict:
    sx, sy = meta['width'] / frames.shape[2], meta['height'] / frames.shape[1]
    return {**found, 'cx': found['cx'] * sx, 'cy': found['cy'] * sy, 'r': found['r'] * max(sx, sy)}


async def find(src, meta: dict, start: float, end: float, prompt: dict, step, report) -> dict:
    from . import track

    frames = None
    try:
        async with step('decode') as facts:
            frames = await asyncio.to_thread(media.track_frames, src, meta, start, end)
            h, w = frames.shape[1:3]
            facts.update(frames=len(frames), size=f'{w}x{h}', fps=(len(frames), ''))
        index = min(len(frames) - 1, round((prompt['time'] - start) * FPS))
        points = [[x * w, y * h, label] for x, y, label in prompt['points']]
        box = [v * s for v, s in zip(prompt['box'], (w, h, w, h), strict=True)] if prompt['box'] else None
        async with step('track') as facts:
            found = await asyncio.to_thread(track.track, frames, index, points, box, prompt.get('mask') or '', report)
            facts.update(fps=(len(frames), ''))
        async with step('cuts'):
            d = await asyncio.to_thread(media.changes, frames)
        return {'start': start, 'n': len(frames), 'found': to_source(found, frames, meta), 'd': d}
    finally:
        if getattr(frames, 'filename', None):
            os.remove(frames.filename)


def sliced(entry: dict | None, start: float, end: float) -> dict | None:
    if not entry:
        return None
    j, n = round((start - entry['start']) * FPS), media.frame_count(start, end)
    if j < 0 or j + n > entry['n']:
        return None
    d = entry['d'][j : j + n].copy()
    d[0] = 0
    return {'found': {k: v[j : j + n] for k, v in entry['found'].items()}, 'cuts': media.scene_cuts(d)}


# [DOC: track-cache]
async def located(state, job_id: str, start: float, end: float, prompt: dict, compute, cancellable: bool):
    name, latest = key(job_id, prompt), f'latest:{job_id}'
    await state.put.aio(latest, name)
    if hit := sliced(await state.get.aio(name), start, end):
        return hit, True
    async with held(state, name):
        if hit := sliced(await state.get.aio(name), start, end):
            return hit, True
        stale = threading.Event()

        async def watch() -> None:
            while not stale.is_set():
                await asyncio.sleep(WATCH)
                if await state.get.aio(latest) != name:
                    stale.set()

        def check() -> None:
            if stale.is_set():
                raise Superseded

        watching = asyncio.create_task(watch()) if cancellable else None
        try:
            entry = await compute(check)
        finally:
            if watching:
                watching.cancel()
        await state.put.aio(name, entry)
        return sliced(entry, start, end), False


async def frame_path(job_id: str, jobs, state, job: dict, src: str) -> tuple[dict, np.ndarray, list]:
    from . import camera

    request, meta, loop = job['request'], job['meta'], asyncio.get_running_loop()
    start, end, prompt = (request[k] for k in SPAN)
    if not follows(meta, request):
        return job, camera.still(media.frame_count(start, end), meta['width'], meta['height']), []

    @contextlib.asynccontextmanager
    async def step(name: str):
        nonlocal job
        job = await stage(jobs, job, STAGES[name])
        with timed(job_id, f'render.{name}') as facts:
            yield facts

    async def compute(check):
        report = reporter(job, 'tracking', loop)
        return await find(src, meta, start, end, prompt, step, lambda f: check() or report(f))

    job = await stage(jobs, job, 'tracking')
    with timed(job_id, 'render.locate') as facts:
        hit, cached = await located(state, job_id, start, end, prompt, compute, cancellable=False)
        facts.update(cached=cached, cuts=len(hit['cuts']))
    job = await stage(jobs, job, 'framing')
    with timed(job_id, 'render.camera'):
        zoom, (w, h) = request['options'].get('zoom', False), (meta['width'], meta['height'])
        path = await asyncio.to_thread(camera.solve, hit['found'], w, h, hit['cuts'], zoom=zoom)
    np.savez(f'{JOBS_DIR}/{job_id}/track.npz', **hit['found'])
    return job, path, hit['cuts']


# [DOC: track-cache]
async def prepare_job(job_id: str, jobs, state, volume, span: dict) -> None:
    from . import track

    job = await jobs.get.aio(job_id)
    if not job.get('source'):
        return
    src, (start, end, prompt) = f'{JOBS_DIR}/{job_id}/{job["source"]}', (span[k] for k in SPAN)
    if not os.path.exists(src):
        with contextlib.suppress(RuntimeError):
            await volume.reload.aio()

    @contextlib.asynccontextmanager
    async def step(name: str):
        with timed(job_id, f'prepare.{name}') as facts:
            yield facts

    async def compute(check):
        await asyncio.to_thread(track.load)
        return await find(src, job['meta'], start, end, prompt, step, lambda _: check())

    try:
        with timed(job_id, 'prepare') as facts:
            facts['cached'] = (await located(state, job_id, start, end, prompt, compute, cancellable=True))[1]
    except Superseded:
        note(job_id, 'prepare.superseded', 0)
    except Exception as error:
        print(f'[{job_id}] prepare failed: {error!r}', flush=True)
