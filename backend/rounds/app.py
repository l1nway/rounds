import asyncio
import contextlib
import importlib
import os
import threading
from functools import partial

import modal

from . import bot, cache, locate, pipeline, retry
from .api import create
from .cloud import MODELS_DIR, app, cpu_image, data, gpu_image, image, jobs, models, secrets, state  # noqa: F401
from .config import DATA_DIR, JOBS_DIR

# [DOC: render-gpus]
LIFT_GPUS = ['L4', 'L40S']
RENDER_GPUS = ['L40S', 'L4']
RENDERS = 2
LIFT_IDLE, RENDER_IDLE = 120, 240
WATCH_MINUTES = 5
CACHE_TTL = 30 * 60  # [DOC: render-cache]
MARK = (b'x-rounds-origin', b'modal')  # [DOC: modal-fallback]
SNAPSHOT_IMPORTS = '.render', '.upscale', 'transformers.models.sam2_video.modeling_sam2_video'

# [DOC: warm-start]
with gpu_image.imports():
    for name in () if modal.is_local() else SNAPSHOT_IMPORTS:
        importlib.import_module(name, __package__)


@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, scaledown_window=300,
              enable_memory_snapshot=True)  # fmt: skip
@modal.concurrent(max_inputs=20)
@modal.asgi_app(requires_proxy_auth=True)  # [DOC: tiers]
def web():
    lift, studio, start = Lift(), Render(), starter()
    calls = {'ingest': partial(start, 'ingest'), 'render': partial(start, 'render'), 'warm': lift.warm.spawn.aio,
             'prepare': studio.prepare.spawn.aio,
             'segment': lift.segment.remote.aio, 'look': lift.look.remote.aio,
             'follow': lift.follow.remote.aio}  # fmt: skip
    return marked(create(jobs, state, data, calls))


# [DOC: modal-fallback]
def marked(api):
    async def asgi(scope, receive, send):
        async def mark(message):
            if message['type'] == 'http.response.start':
                message = {**message, 'headers': [*message.get('headers', []), MARK]}
            await send(message)

        await api(scope, receive, mark if scope['type'] == 'http' else send)

    return asgi


# [DOC: mtproto-keys]
@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, cpu=2, memory=4096, timeout=3600,
              max_containers=1, region='eu', enable_memory_snapshot=True)  # fmt: skip
async def ingest(job_id: str) -> None:
    async with bot.session():  # [DOC: bot-session]
        await pipeline.ingest_job(job_id, jobs, state, data)


# [DOC: render-warm]
@app.cls(image=gpu_image, gpu=RENDER_GPUS, secrets=secrets, volumes={DATA_DIR: data, MODELS_DIR: models}, cpu=4,
         memory=16384, timeout=3600, max_containers=RENDERS, scaledown_window=RENDER_IDLE,
         enable_memory_snapshot=True)  # fmt: skip
@modal.concurrent(max_inputs=2, target_inputs=1)
class Render:
    @modal.enter()
    def setup(self):
        self.running = asyncio.Lock()

    @modal.method()
    async def warm(self) -> None:
        pass

    # [DOC: track-cache]
    @modal.method()
    async def prepare(self, job_id: str, span: dict) -> None:
        await locate.prepare_job(job_id, jobs, state, data, span)

    @modal.method()
    async def run(self, job_id: str) -> None:
        async with self.running, bot.session():
            await pipeline.render_job(job_id, jobs, state, data, models)


# [DOC: lift]
@app.cls(image=gpu_image, gpu=LIFT_GPUS, volumes={DATA_DIR: data, MODELS_DIR: models}, cpu=2, memory=8192, timeout=120,
         max_containers=1, scaledown_window=LIFT_IDLE, enable_memory_snapshot=True)  # fmt: skip
@modal.concurrent(max_inputs=3)  # [DOC: track-preview]
class Lift:
    @modal.enter(snap=True)
    def load(self):
        from . import follow, render, repair
        from .segment import Segmenter

        self.segmenter, self.nets, self.preview = Segmenter(), repair.load(), render.preview
        self.tracker = follow.load()

    @modal.enter(snap=False)
    def to_gpu(self):
        from . import repair

        self.segmenter.to('cuda')
        self.nets = repair.to(self.nets, 'cuda')
        self.tracker.to('cuda')
        self.quick, self.slow, self.latest = threading.Lock(), threading.Lock(), 0

    @modal.method()
    def warm(self) -> None:
        pass

    @modal.method()
    def segment(self, job_id: str, at: float, points: list, box: list | None, size: tuple[int, int]) -> dict:
        if not os.path.exists(f'{JOBS_DIR}/{job_id}/proxy.mp4'):
            data.reload()
        with self.quick:
            return self.segmenter.segment(job_id, at, points, box, size)

    # [DOC: look-preview]
    @modal.method()
    def look(self, job_id: str, at: float, name: str, meta: dict, value: float, ev: float, size: tuple) -> dict:
        src = f'{JOBS_DIR}/{job_id}/{name}'
        if not os.path.exists(src):
            data.reload()
        with self.quick:
            return self.preview(src, meta, at, value, ev, size, self.nets)

    # [DOC: track-preview]
    @modal.method()
    def follow(self, job_id: str, at: float, prompt: dict, start: float, end: float, size: tuple) -> dict | None:
        from . import follow

        proxy = f'{JOBS_DIR}/{job_id}/proxy.mp4'
        if not os.path.exists(proxy):
            data.reload()
        self.latest = mine = self.latest + 1
        with self.slow:
            return follow.follow(self.tracker, proxy, size, prompt, start, end, lambda: self.latest != mine)


@app.function(image=cpu_image, secrets=secrets)
async def setup() -> str:
    from .config import env

    url = env('ROUTER_URL')  # [DOC: tiers]
    async with bot.session():
        await bot.get_bot().set_webhook(
            f'{url}/telegram/webhook', secret_token=env('TELEGRAM_WEBHOOK_SECRET'), allowed_updates=bot.UPDATES
        )
    return url


# [DOC: render-cache]
@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, cpu=4, memory=4096, timeout=3600)
async def reencode(job_id: str) -> None:
    async with bot.session():
        job = await jobs.get.aio(job_id)
        if not await cache.reuse(job, jobs, data, user=job['user_id']):
            await starter()('render', job_id)


async def route(job_id: str):
    job = await jobs.get.aio(job_id)
    with contextlib.suppress(RuntimeError):
        await data.reload.aio()
    if not await asyncio.to_thread(cache.ready, f'{JOBS_DIR}/{job_id}', job['request']):
        return await Render().run.spawn.aio(job_id)
    await bot.status(job, bot.TEXTS['reusing'].format(0))
    return await reencode.spawn.aio(job_id)


# [DOC: stuck-jobs]
def starter():
    return partial(retry.start, {'ingest': ingest.spawn.aio, 'render': route}, state)


@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, schedule=modal.Period(minutes=WATCH_MINUTES),
              scaledown_window=2)  # fmt: skip
async def watch() -> None:
    with contextlib.suppress(RuntimeError):
        await data.reload.aio()
    if await asyncio.to_thread(cache.expire, CACHE_TTL):  # [DOC: render-cache]
        await data.commit.aio()
    async with bot.session():
        await retry.watch(jobs, state, starter())


# [DOC: upscale-image]
from . import painter, upscale  # noqa: E402, F401
