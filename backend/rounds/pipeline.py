import asyncio
import os
import time
import traceback

import numpy as np

from . import bot, media, transfer
from .config import FPS, JOBS_DIR

PROGRESS_INTERVAL = 3


def reporter(job: dict, stage: str, loop: asyncio.AbstractEventLoop):
    last = 0.0

    def report(fraction: float) -> None:
        nonlocal last
        if time.monotonic() - last >= PROGRESS_INTERVAL:
            last = time.monotonic()
            asyncio.run_coroutine_threadsafe(bot.status(job, bot.TEXTS[stage].format(fraction)), loop)

    return report


async def save(jobs, job: dict, **update) -> dict:
    job = {**job, **update}
    await jobs.put.aio(job['id'], job)
    return job


async def stage(jobs, job: dict, name: str) -> dict:
    await bot.status(job, bot.TEXTS[name].format(0))
    return await save(jobs, job, stage=name)


async def fail(jobs, job: dict, error: Exception) -> None:
    traceback.print_exception(error)
    job = await save(jobs, job, status='failed', stage=None, error=str(error))
    await bot.status(job, bot.TEXTS['failed'].format(error), bot.editor(job['id']))


async def ingest_job(job_id: str, jobs, state, volume) -> None:
    job = await jobs.get.aio(job_id)
    job_dir = f'{JOBS_DIR}/{job_id}'
    os.makedirs(job_dir, exist_ok=True)
    try:
        report = reporter(job, 'downloading', asyncio.get_running_loop())
        async with transfer.client(state, 'ingest') as tg:
            src = await transfer.download(tg, job['source_message_id'], f'{job_dir}/source', report)
        await bot.status(job, bot.TEXTS['preparing'])
        meta = await asyncio.to_thread(media.probe, src)
        extra = await asyncio.to_thread(media.make_proxy, src, job_dir, meta)
        await volume.commit.aio()
        job = await save(jobs, job, source=os.path.basename(src), meta=meta, status='ready', **extra)
        await bot.status(job, bot.TEXTS['ready'], bot.editor(job_id))
    except Exception as error:
        await fail(jobs, job, error)


def to_source(found: dict, frames: np.ndarray, meta: dict) -> dict:
    sx, sy = meta['width'] / frames.shape[2], meta['height'] / frames.shape[1]
    return {**found, 'cx': found['cx'] * sx, 'cy': found['cy'] * sy, 'r': found['r'] * max(sx, sy)}


async def render_job(job_id: str, jobs, state, volume) -> None:
    from . import camera, render, track

    await volume.reload.aio()
    job = await jobs.get.aio(job_id)
    job_dir, request, meta = f'{JOBS_DIR}/{job_id}', job['request'], job['meta']
    start, end, prompt = request['start'], request['end'], request['prompt']
    loop = asyncio.get_running_loop()
    frames = None
    try:
        reply = await bot.get_bot().send_message(
            job['chat_id'], bot.TEXTS['tracking'].format(0), reply_to_message_id=job['source_message_id']
        )
        job = await save(jobs, job, status_message_id=reply.message_id, stage='tracking')
        src = f'{job_dir}/{job["source"]}'
        frames = await asyncio.to_thread(media.track_frames, src, meta, start, end)
        h, w = frames.shape[1:3]
        index = min(len(frames) - 1, round((prompt['time'] - start) * FPS))
        points = [[x * w, y * h, label] for x, y, label in prompt['points']]
        box = [v * s for v, s in zip(prompt['box'], (w, h, w, h), strict=True)] if prompt['box'] else None
        report = reporter(job, 'tracking', loop)
        found = await asyncio.to_thread(track.track, frames, index, points, box, progress=report)
        cuts = await asyncio.to_thread(media.scene_cuts, frames)
        job = await stage(jobs, job, 'framing')
        found = to_source(found, frames, meta)
        path = await asyncio.to_thread(camera.solve, found, meta['width'], meta['height'], cuts)
        np.savez(f'{job_dir}/track.npz', **found)
        np.save(f'{job_dir}/path.npy', path)
        job = await stage(jobs, job, 'rendering')
        out, report = f'{job_dir}/note.mp4', reporter(job, 'rendering', loop)
        result = await asyncio.to_thread(render.render, src, meta, start, end, path, out, request['options'], report)
        await volume.commit.aio()
        job = await stage(jobs, job, 'sending')
        async with transfer.client(state, 'render') as tg:
            await transfer.send_note(tg, job['chat_id'], job['source_message_id'], out, result['duration'])
        job = await save(jobs, job, status='done', stage=None, progress=1)
        await bot.status(job, bot.TEXTS['done'], bot.editor(job_id))
    except Exception as error:
        await fail(jobs, job, error)
    finally:
        if getattr(frames, 'filename', None):
            os.remove(frames.filename)
