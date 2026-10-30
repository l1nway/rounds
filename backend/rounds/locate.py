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
    square, zoom = meta['width'] == meta['height'], request['options'].get('zoom', False)
    return request['prompt']['time'] is not None and not request['prompt'].get('crop') and (not square or zoom)


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


def flowing(src, meta: dict, request: dict):
    from . import motion, source

    rate, start, end = source.out_rate(meta, request['options']), request['start'], request['end']
    args = src, meta, start, media.frame_count(start, end, rate), rate, source.interpolating(meta, request['options'])
    return asyncio.create_task(asyncio.to_thread(motion.flows, *args))


# [DOC: crop-mode]
def fixed(meta: dict, prompt: dict, n: int) -> np.ndarray:
    from . import camera, crop

    if not prompt.get('crop'):
        return camera.still(n, meta['width'], meta['height'])
    side, x, y = crop.frame(meta, prompt, False)
    return np.tile([x + side / 2, y + side / 2, side], (n, 1)).astype(float)


# [DOC: stabilization]
async def frame_path(job_id: str, jobs, state, job: dict, src: str) -> tuple[dict, np.ndarray, list, dict | None]:
    from . import camera, motion

    request, meta, loop = job['request'], job['meta'], asyncio.get_running_loop()
    start, end, size = request['start'], request['end'], (meta['width'], meta['height'])
    n, strength, tracked = media.frame_count(start, end), request.get('stabilize', 0), follows(meta, request)
    moving = flowing(src, meta, request) if strength > 0 else None
    if not tracked and not moving:
        return job, fixed(meta, request['prompt'], n), [], None
    hit = {'found': {'present': np.zeros(n, bool), **dict.fromkeys(('cx', 'cy', 'r'), np.full(n, np.nan))}, 'cuts': []}
    if tracked:
        job, hit = await tracking(job_id, jobs, state, job, src, loop)
    job, world = await stage(jobs, job, 'framing'), None
    if moving:
        with timed(job_id, 'render.motion') as facts:
            flow = await moving
            p = await asyncio.to_thread(motion.params, flow, size, hit['found'] if tracked else None, hit['cuts'])
            world = motion.world(flow, p, strength, size, n) if len(flow['t']) > 1 else None
            facts.update(frames=len(flow['t']))
    with timed(job_id, 'render.camera'):
        zoom, crop = request['options'].get('zoom', False), request['prompt'].get('crop')
        args = (meta, request['prompt'], n) if crop else (hit['found'], *size, hit['cuts'], FPS, zoom, world)
        path = await asyncio.to_thread(fixed if crop else camera.solve, *args)
    if tracked:
        np.savez(f'{JOBS_DIR}/{job_id}/track.npz', **hit['found'])
    return job, path, hit['cuts'], world


async def tracking(job_id: str, jobs, state, job: dict, src: str, loop) -> tuple[dict, dict]:
    request, meta = job['request'], job['meta']
    start, end, prompt = (request[k] for k in SPAN)

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
    return job, hit


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
