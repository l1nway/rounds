import asyncio
import contextlib
import os
import time
import traceback

import numpy as np

from . import bot, media, source, transfer
from .config import FPS, JOBS_DIR

PROGRESS_INTERVAL = 3
MB = 1 << 20
UNEXPECTED = 'The details are in the bot log'
STDERR_TAIL = 4000


def reporter(job: dict, stage: str, loop: asyncio.AbstractEventLoop):
    last = 0.0

    def report(fraction: float) -> None:
        nonlocal last
        if time.monotonic() - last >= PROGRESS_INTERVAL:
            last = time.monotonic()
            asyncio.run_coroutine_threadsafe(bot.status(job, bot.TEXTS[stage].format(fraction)), loop)

    return report


# [DOC: stage-timings]
def note(job_id: str, step: str, took: float, **facts) -> None:
    took = max(took, 1e-3)
    pairs = (f'{k}={v[0] / took:.1f}{v[1]}' if isinstance(v, tuple) else f'{k}={v}' for k, v in facts.items())
    print(f'[{job_id}] {step} {took:.1f}s', *pairs, flush=True)


@contextlib.contextmanager
def timed(job_id: str, step: str):
    facts, began = {}, time.monotonic()
    yield facts
    note(job_id, step, time.monotonic() - began, **facts)


def waited(job: dict) -> float:
    return time.time() - job.get('queued_at', time.time())


def describe(meta: dict) -> dict:
    size = f'{meta["width"]}x{meta["height"]}'
    keys = ('fps', 'gaps', 'codec', 'transfer', 'bit_depth', 'duration', 'has_audio')
    return {
        'size': size,
        **{k: round(meta[k], 2) if isinstance(meta[k], float) else meta[k] for k in keys if k in meta},
    }


async def save(jobs, job: dict, **update) -> dict:
    job = {**job, **update}
    await jobs.put.aio(job['id'], job)
    return job


async def stage(jobs, job: dict, name: str) -> dict:
    await bot.status(job, bot.TEXTS[name].format(0))
    return await save(jobs, job, stage=name)


# [DOC: broken-sources]
async def fail(jobs, job: dict, error: Exception) -> None:
    traceback.print_exception(error)
    for cause in (error, error.__cause__):
        if getattr(cause, 'stderr', None):
            print(cause.stderr[-STDERR_TAIL:], flush=True)
    reason = str(error) if isinstance(error, source.Unreadable) else UNEXPECTED
    job = await save(jobs, job, status='failed', stage=None, error=reason)
    await bot.status(job, bot.TEXTS['failed'].format(reason), bot.editor(job['id']))


async def ingest_job(job_id: str, jobs, state, volume) -> None:
    began = time.monotonic()
    job = await jobs.get.aio(job_id)
    note(job_id, 'ingest.wait', waited(job))
    job_dir = f'{JOBS_DIR}/{job_id}'
    os.makedirs(job_dir, exist_ok=True)
    try:
        report = reporter(job, 'downloading', asyncio.get_running_loop())
        async with bot.acting(job['chat_id'], 'typing'):
            async with transfer.client(state, 'ingest') as tg:
                with timed(job_id, 'ingest.download') as facts:
                    src = await transfer.download(tg, job['source_message_id'], f'{job_dir}/source', report)
                    size = os.path.getsize(src) / MB
                    facts.update(mb=round(size), speed=(size, 'MB/s'))
            await bot.status(job, bot.TEXTS['probing'])
            with timed(job_id, 'ingest.probe') as facts:
                meta = await asyncio.to_thread(source.probe, src)
                facts.update(describe(meta), tags=len(meta['tags']))
            await bot.status(job, bot.TEXTS['preparing'])
            with timed(job_id, 'ingest.proxy') as facts:
                extra, checked = await asyncio.to_thread(media.make_proxy, src, job_dir, meta)
                meta = {**meta, **checked}
                meta['interpolable'] = source.interpolable(meta)
                facts.update(speed=(meta['duration'], 'x'), **checked, interpolable=meta['interpolable'])
            with timed(job_id, 'ingest.commit'):
                await volume.commit.aio()
        job = await save(jobs, job, source=os.path.basename(src), meta=meta, status='ready', **extra)
        await bot.status(job, bot.TEXTS['ready'], bot.editor(job_id))
        note(job_id, 'ingest', time.monotonic() - began)
    except Exception as error:
        await fail(jobs, job, error)


def to_source(found: dict, frames: np.ndarray, meta: dict) -> dict:
    sx, sy = meta['width'] / frames.shape[2], meta['height'] / frames.shape[1]
    return {**found, 'cx': found['cx'] * sx, 'cy': found['cy'] * sy, 'r': found['r'] * max(sx, sy)}


async def render_job(job_id: str, jobs, state, volume, models) -> None:
    from . import camera, render, track

    began = time.monotonic()
    job = await jobs.get.aio(job_id)
    note(job_id, 'render.wait', waited(job))
    with timed(job_id, 'render.load'):
        await asyncio.to_thread(track.load)
        await models.commit.aio()
    await volume.reload.aio()
    job_dir, request, meta = f'{JOBS_DIR}/{job_id}', job['request'], job['meta']
    start, end, prompt = request['start'], request['end'], request['prompt']
    loop = asyncio.get_running_loop()
    frames = None
    try:
        src, out = f'{job_dir}/{job["source"]}', f'{job_dir}/note.mp4'
        async with bot.acting(job['chat_id'], 'record_video_note'):
            job = await stage(jobs, job, 'decoding')
            with timed(job_id, 'render.decode') as facts:
                frames = await asyncio.to_thread(media.track_frames, src, meta, start, end)
                h, w = frames.shape[1:3]
                facts.update(frames=len(frames), size=f'{w}x{h}', fps=(len(frames), ''))
            index = min(len(frames) - 1, round((prompt['time'] - start) * FPS))
            points = [[x * w, y * h, label] for x, y, label in prompt['points']]
            box = [v * s for v, s in zip(prompt['box'], (w, h, w, h), strict=True)] if prompt['box'] else None
            job = await stage(jobs, job, 'tracking')
            with timed(job_id, 'render.track') as facts:
                found = await asyncio.to_thread(
                    track.track, frames, index, points, box, prompt.get('mask') or '', reporter(job, 'tracking', loop)
                )
                facts.update(fps=(len(frames), ''))
            job = await stage(jobs, job, 'cuts')
            with timed(job_id, 'render.cuts') as facts:
                cuts = await asyncio.to_thread(media.scene_cuts, frames)
                facts.update(cuts=len(cuts))
            job = await stage(jobs, job, 'framing')
            with timed(job_id, 'render.camera'):
                found = to_source(found, frames, meta)
                path = await asyncio.to_thread(camera.solve, found, meta['width'], meta['height'], cuts)
            np.savez(f'{job_dir}/track.npz', **found)
            np.save(f'{job_dir}/path.npy', path)
            job = await stage(jobs, job, 'rendering')
            report = reporter(job, 'rendering', loop)
            with timed(job_id, 'render.encode') as facts:
                result = await asyncio.to_thread(
                    render.render, src, meta, start, end, path, cuts, out, request['options'], report
                )
                stats = {k: v for k, v in result.items() if k in ('rate', 'synth', 'dupes')}
                facts.update(fps=(result['frames'], ''), mb=round(result['size'] / MB, 1), **stats)
            with timed(job_id, 'render.commit'):
                await volume.commit.aio()
        job = await stage(jobs, job, 'sending')
        with timed(job_id, 'render.send') as facts:
            async with transfer.client(state, 'render') as tg:
                await transfer.send_note(tg, job['chat_id'], job['source_message_id'], out, result['duration'])
            facts.update(speed=(result['size'] / MB, 'MB/s'))
        job = await save(jobs, job, status='done', stage=None, progress=1)
        await bot.status(job, bot.TEXTS['done'], bot.editor(job_id))
        note(job_id, 'render', time.monotonic() - began, clip=round(end - start, 2), **describe(meta))
    except Exception as error:
        await fail(jobs, job, error)
    finally:
        if getattr(frames, 'filename', None):
            os.remove(frames.filename)
