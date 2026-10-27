import asyncio
import contextlib
import os
import time
import traceback

import numpy as np

from . import bot, media, source, transfer
from .config import JOBS_DIR

PROGRESS_INTERVAL = 3
MB = 1 << 20
UNEXPECTED = 'The details are in the bot log'
STDERR_TAIL = 4000
LOGGED = ('codec', 'fit', 'upscale', 'rate', 'synth', 'dupes', 'seams')


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
    await save(
        jobs, job, status_message_id=await bot.announce(job, bot.TEXTS['failed'].format(reason), bot.editor(job))
    )


async def ingest_job(job_id: str, jobs, state, volume) -> None:
    began = time.monotonic()
    job = await jobs.get.aio(job_id)
    note(job_id, 'ingest.wait', waited(job))
    job_dir = f'{JOBS_DIR}/{job_id}'
    os.makedirs(job_dir, exist_ok=True)
    try:
        report = reporter(job, 'downloading', asyncio.get_running_loop())
        async with bot.acting(job['chat_id'], 'typing'):
            async with transfer.clients(state, 'ingest') as tg:
                with timed(job_id, 'ingest.download') as facts:
                    src = await transfer.download(tg, job['source_message_id'], f'{job_dir}/source', report)
                    size = os.path.getsize(src) / MB
                    facts.update(mb=round(size), speed=(size, 'MB/s'), region=os.environ.get('MODAL_REGION'))
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
        await save(jobs, job, status_message_id=await bot.announce(job, bot.TEXTS['ready'], bot.editor(job)))
        note(job_id, 'ingest', time.monotonic() - began)
    except Exception as error:
        await fail(jobs, job, error)


async def render_job(job_id: str, jobs, state, volume, models) -> None:
    import torch

    from . import locate, render, track, upscale

    began = time.monotonic()
    job = await jobs.get.aio(job_id)
    note(job_id, 'render.wait', waited(job))
    with timed(job_id, 'render.load') as facts:
        facts['gpu'] = torch.cuda.get_device_name().replace(' ', '_') if torch.cuda.is_available() else 'cpu'
        if locate.follows(job['meta'], job['request']):
            await asyncio.to_thread(track.load)
        if upscale.wanted(job['meta'], job['request']['options']):
            await asyncio.to_thread(upscale.fetch)
        await models.commit.aio()
    with contextlib.suppress(RuntimeError):  # open files of a prepare
        await volume.reload.aio()
    job_dir, request, meta = f'{JOBS_DIR}/{job_id}', job['request'], job['meta']
    start, end, loop = request['start'], request['end'], asyncio.get_running_loop()
    try:
        src, out = f'{job_dir}/{job["source"]}', f'{job_dir}/note.mp4'
        async with bot.acting(job['chat_id'], 'record_video_note'):
            job, path, cuts = await locate.frame_path(job_id, jobs, state, job, src)
            np.save(f'{job_dir}/path.npy', path)
            job = await stage(jobs, job, 'rendering')
            report = reporter(job, 'rendering', loop)
            options = {**request['options'], **{k: request.get(k, 0) for k in ('denoise', 'look', 'exposure')}}
            args = (src, meta, start, end, path, cuts, out, options, request.get('codec', 'av1'), report)
            with timed(job_id, 'render.encode') as facts:
                result = await asyncio.to_thread(render.render, *args)
                stats = {k: v for k, v in result.items() if k in LOGGED}
                facts.update(fps=(result['frames'], ''), mb=round(result['size'] / MB, 1), **stats)
            with timed(job_id, 'render.commit'):
                await volume.commit.aio()
        job = await stage(jobs, job, 'sending')
        with timed(job_id, 'render.send') as facts:
            await bot.send_note(job, out, result['duration'])
            facts.update(speed=(result['size'] / MB, 'MB/s'))
        job = await save(jobs, job, status='done', stage=None, progress=1)
        await bot.status(job, bot.TEXTS['done'], bot.editor(job))
        note(job_id, 'render', time.monotonic() - began, clip=round(end - start, 2), **describe(meta))
    except Exception as error:
        await fail(jobs, job, error)
