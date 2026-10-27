import asyncio
import importlib
import os
import threading
from functools import partial
from pathlib import Path

import modal

from . import bot, locate, pipeline
from .api import create
from .config import DATA_DIR, DCE_WEIGHTS, DEEP_FILTER, DVD_WEIGHTS, JOBS_DIR, RIFE_WEIGHTS

PROJECT = Path(__file__).parent.parent
FFMPEG = (
    'https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/'
    'ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0.tar.xz',
    '68ee646831adaae2495618346f3bba94ff207ff83bbd34d643e7004730d66269',
)
RIFE = (
    'https://github.com/HolyWu/vs-rife/releases/download/model/flownet_v4.25.pkl',
    '6615790efd627772917205db291f51cd392528a157ecbb2ecaeec3bff8eb6de2',
)
# [DOC: denoise]
VOICE = (
    'https://github.com/Rikorose/DeepFilterNet/releases/download/v0.5.6/deep-filter-0.5.6-x86_64-unknown-linux-musl',
    '70775e251eee44c0f2451a1e833326cf8bcbbe304d3e7cd12851e6fce72ef7da',
)
# [DOC: repair-weights]
REPAIR = (
    (DVD_WEIGHTS, 'https://raw.githubusercontent.com/m-tassano/fastdvdnet/c8fdf6182a0340e89dd18f5df25b47337cbede6f/'
     'model.pth', '9d9d8413c33e3d9d961d07c530237befa1197610b9d60602ff42fd77975d2a17'),
    (DCE_WEIGHTS, 'https://raw.githubusercontent.com/Li-Chongyi/Zero-DCE_extension/'
     '09f202b690f82da939b8e6ec8535960ae97ad8bd/Zero-DCE%2B%2B/snapshots_Zero_DCE%2B%2B/Epoch99.pth',
     'ca8855b90df9a80fa4195a831f33d3476b1964f787eb70602797c773067f3b84'),
)  # fmt: skip
MODELS_DIR = '/models'
# [DOC: render-gpus]
LIFT_GPUS = ['L4', 'L40S', 'A100-40GB']
RENDER_GPUS = ['L40S', 'A100-40GB', 'L4', 'H100']
RENDERS = 2
LIFT_IDLE, RENDER_IDLE = 120, 240
WATCH_MINUTES = 2
SNAPSHOT_IMPORTS = '.render', '.upscale', 'transformers.models.sam2_video.modeling_sam2_video'


def fetch(path: str, url: str, sha: str) -> tuple[str, str]:
    return f'curl -fsSL --create-dirs -o {path} {url}', f'echo "{sha}  {path}" | sha256sum -c'


def image(*groups: str, commands: tuple[str, ...] = (), base: modal.Image | None = None) -> modal.Image:
    return (
        (base or modal.Image.debian_slim(python_version='3.12'))
        .apt_install('curl', 'xz-utils', 'git')
        .run_commands(
            f'curl -fsSL -o /tmp/ffmpeg.tar.xz {FFMPEG[0]}',
            f'echo "{FFMPEG[1]}  /tmp/ffmpeg.tar.xz" | sha256sum -c',
            'tar -xJf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=2 --wildcards "*/bin/ff*"',
            'rm /tmp/ffmpeg.tar.xz && ffmpeg -hide_banner -version | head -1',
            *commands,
        )
        .uv_sync(str(PROJECT), groups=list(groups), extra_options='--no-dev')
        .env({'HF_HOME': f'{MODELS_DIR}/hf'})
        .add_local_python_source('rounds')
    )


app = modal.App('rounds')
# [DOC: rife-weights]
weights = tuple(c for f in ((RIFE_WEIGHTS, *RIFE), *REPAIR) for c in fetch(*f))
voice = (*fetch(DEEP_FILTER, *VOICE), f'chmod +x {DEEP_FILTER} && {DEEP_FILTER} --version')
cpu_image, gpu_image = image(), image('gpu', commands=(*weights, *voice))
data = modal.Volume.from_name('rounds-data', create_if_missing=True)
models = modal.Volume.from_name('rounds-models', create_if_missing=True)
jobs = modal.Dict.from_name('rounds-jobs', create_if_missing=True)
state = modal.Dict.from_name('rounds-state', create_if_missing=True)
secrets = [modal.Secret.from_name('rounds')]
# [DOC: warm-start]
with gpu_image.imports():
    for name in () if modal.is_local() else SNAPSHOT_IMPORTS:
        importlib.import_module(name, __package__)


@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, scaledown_window=300,
              enable_memory_snapshot=True)  # fmt: skip
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def web():
    lift, studio, start = Lift(), Render(), starter()
    calls = {'ingest': partial(start, 'ingest'), 'render': partial(start, 'render'), 'warm': lift.warm.spawn.aio,
             'warm_render': studio.warm.spawn.aio, 'prepare': studio.prepare.spawn.aio,
             'segment': lift.segment.remote.aio, 'look': lift.look.remote.aio,
             'follow': lift.follow.remote.aio}  # fmt: skip
    return create(jobs, data, calls)


# [DOC: mtproto-keys]
@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, cpu=4, memory=4096, timeout=3600,
              max_containers=1, region='eu', enable_memory_snapshot=True)  # fmt: skip
async def ingest(job_id: str) -> None:
    async with bot.session():  # [DOC: bot-session]
        await pipeline.ingest_job(job_id, jobs, state, data)


# [DOC: render-warm]
@app.cls(image=gpu_image, gpu=RENDER_GPUS, secrets=secrets, volumes={DATA_DIR: data, MODELS_DIR: models}, cpu=8,
         memory=32768, timeout=3600, max_containers=RENDERS, scaledown_window=RENDER_IDLE,
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

    url = await modal.Function.from_name('rounds', 'web').get_web_url.aio()
    async with bot.session():
        await bot.get_bot().set_webhook(
            f'{url}/telegram/webhook', secret_token=env('TELEGRAM_WEBHOOK_SECRET'), allowed_updates=['message']
        )
    return url


# [DOC: stuck-jobs]
def starter():
    return partial(pipeline.start, {'ingest': ingest.spawn.aio, 'render': Render().run.spawn.aio}, state)


@app.function(image=cpu_image, secrets=secrets, schedule=modal.Period(minutes=WATCH_MINUTES), scaledown_window=2)
async def watch() -> None:
    async with bot.session():
        await pipeline.watch(jobs, state, starter())


# [DOC: upscale-image]
from . import upscale  # noqa: E402, F401
