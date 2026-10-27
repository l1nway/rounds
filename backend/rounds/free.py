import asyncio
import os
import shutil
import time
from contextlib import asynccontextmanager
from pathlib import Path

from . import bot, config, crop, pipeline
from .api import create
from .config import DATA_DIR, JOBS_DIR
from .store import Disk, Store

# [DOC: free-server]
INGESTS, RENDERS = 2, 1
KEEP, SWEEP = 48 * 3600, 3600
RESTARTED = 'The server restarted, try again'

config.PUBLIC = True  # [DOC: tiers]
os.makedirs(JOBS_DIR, exist_ok=True)
jobs, state, disk = Store(f'{DATA_DIR}/rounds.db', 'jobs'), Store(f'{DATA_DIR}/rounds.db', 'state'), Disk()
lanes = {'ingest': asyncio.Semaphore(INGESTS), 'render': asyncio.Semaphore(RENDERS)}
running = set()


# [DOC: free-render]
async def render_job(job_id: str) -> None:
    began, job = time.monotonic(), await jobs.get.aio(job_id)
    pipeline.note(job_id, 'render.wait', pipeline.waited(job))
    job_dir = f'{JOBS_DIR}/{job_id}'
    try:
        src, out = f'{job_dir}/{job["source"]}', f'{job_dir}/note.mp4'
        async with bot.acting(job['chat_id'], 'record_video_note'):
            job = await pipeline.stage(jobs, job, 'rendering')
            report = pipeline.reporter(job, 'rendering', asyncio.get_running_loop())
            with pipeline.timed(job_id, 'render.encode') as facts:
                result = await asyncio.to_thread(crop.render, src, job['meta'], job['request'], out, report)
                facts.update(fps=(result['frames'], ''), mb=round(result['size'] / pipeline.MB, 1), fit=result['fit'])
        job = await pipeline.stage(jobs, job, 'sending')
        held = await bot.deliver(job, out, result['duration'])  # [DOC: restricted-notes]
        job = await pipeline.save(jobs, job, status='done', stage=None, progress=1, held=held)
        await pipeline.save(jobs, job, status_message_id=await bot.finish(job))
        pipeline.note(job_id, 'render', time.monotonic() - began, **pipeline.describe(job['meta']))
    except Exception as error:
        await pipeline.fail(jobs, job, error)


def queued(kind: str, work):
    async def go(job_id: str) -> None:
        async with lanes[kind]:
            await work(job_id)

    async def spawn(job_id: str) -> None:
        task = asyncio.create_task(go(job_id))
        running.add(task)
        task.add_done_callback(running.discard)

    return spawn


async def recover() -> None:
    async for _, job in jobs.items.aio():
        if job['status'] in pipeline.ACTIVE:
            await pipeline.fail(jobs, job, pipeline.Interrupted(RESTARTED))


# [DOC: free-sweep]
async def sweep() -> None:
    while True:
        old = time.time() - KEEP
        async for job_id, job in jobs.items.aio():
            if job.get('queued_at', 0) < old and job['status'] not in pipeline.ACTIVE:
                await jobs.pop.aio(job_id, None)
                shutil.rmtree(Path(JOBS_DIR, job_id), ignore_errors=True)
        await asyncio.sleep(SWEEP)


async def ingest(job_id: str) -> None:
    await pipeline.ingest_job(job_id, jobs, state, disk)


async def idle() -> None:
    pass


app = create(jobs, disk, {'ingest': queued('ingest', ingest), 'render': queued('render', render_job), 'warm': idle},
             tier='free')  # fmt: skip
inner = app.router.lifespan_context


@asynccontextmanager
async def lifespan(api):
    await recover()
    sweeper = asyncio.create_task(sweep())
    async with inner(api):
        yield
    sweeper.cancel()


app.router.lifespan_context = lifespan
