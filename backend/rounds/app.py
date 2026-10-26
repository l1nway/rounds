import os
from pathlib import Path

import modal

from . import pipeline
from .config import DATA_DIR, DEEP_FILTER, JOBS_DIR, RIFE_WEIGHTS, SEEDVR_CODE

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
# [DOC: upscale]
SEEDVR = 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler', '4490bd1f482e026674543386bb2a4d176da245b9'
MODELS_DIR = '/models'
GPU = 'L4'
LIFT_IDLE = 120


def image(*groups: str, commands: tuple[str, ...] = ()) -> modal.Image:
    return (
        modal.Image.debian_slim(python_version='3.12')
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
weights = (f'curl -fsSL --create-dirs -o {RIFE_WEIGHTS} {RIFE[0]}', f'echo "{RIFE[1]}  {RIFE_WEIGHTS}" | sha256sum -c')
seedvr = (f'git init -q {SEEDVR_CODE} && git -C {SEEDVR_CODE} fetch -q --depth 1 {SEEDVR[0]} {SEEDVR[1]}',
          f'git -C {SEEDVR_CODE} checkout -q FETCH_HEAD')  # fmt: skip
voice = (f'curl -fsSL -o {DEEP_FILTER} {VOICE[0]}', f'echo "{VOICE[1]}  {DEEP_FILTER}" | sha256sum -c',
         f'chmod +x {DEEP_FILTER} && {DEEP_FILTER} --version')  # fmt: skip
cpu_image, gpu_image = image(), image('gpu', commands=(*weights, *seedvr, *voice))
data = modal.Volume.from_name('rounds-data', create_if_missing=True)
models = modal.Volume.from_name('rounds-models', create_if_missing=True)
jobs = modal.Dict.from_name('rounds-jobs', create_if_missing=True)
state = modal.Dict.from_name('rounds-state', create_if_missing=True)
secrets = [modal.Secret.from_name('rounds')]


@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, scaledown_window=300)
@modal.concurrent(max_inputs=20)
@modal.asgi_app()
def web():
    from .api import create

    lift = Lift()
    calls = {'ingest': ingest.spawn.aio, 'render': render.spawn.aio, 'warm': lift.warm.spawn.aio,
             'segment': lift.segment.remote.aio}  # fmt: skip
    return create(jobs, data, calls)


@app.function(image=cpu_image, secrets=secrets, volumes={DATA_DIR: data}, cpu=4, memory=4096, timeout=3600,
              max_containers=1)  # fmt: skip
async def ingest(job_id: str) -> None:
    await pipeline.ingest_job(job_id, jobs, state, data)


@app.function(image=gpu_image, gpu=GPU, secrets=secrets, volumes={DATA_DIR: data, MODELS_DIR: models}, cpu=8,
              memory=32768, timeout=3600, max_containers=1)  # fmt: skip
async def render(job_id: str) -> None:
    await pipeline.render_job(job_id, jobs, state, data, models)


# [DOC: lift]
@app.cls(image=gpu_image, gpu=GPU, volumes={DATA_DIR: data, MODELS_DIR: models}, cpu=2, memory=8192, timeout=120,
         max_containers=1, scaledown_window=LIFT_IDLE, enable_memory_snapshot=True)  # fmt: skip
class Lift:
    @modal.enter(snap=True)
    def load(self):
        from .segment import Segmenter

        self.segmenter = Segmenter()

    @modal.enter(snap=False)
    def to_gpu(self):
        self.segmenter.to('cuda')

    @modal.method()
    def warm(self) -> None:
        pass

    @modal.method()
    def segment(self, job_id: str, at: float, points: list, box: list | None, size: tuple[int, int]) -> dict:
        if not os.path.exists(f'{JOBS_DIR}/{job_id}/proxy.mp4'):
            data.reload()
        return self.segmenter.segment(job_id, at, points, box, size)


@app.function(image=cpu_image, secrets=secrets)
async def setup() -> str:
    from .bot import get_bot
    from .config import env

    url = await modal.Function.from_name('rounds', 'web').get_web_url.aio()
    await get_bot().set_webhook(
        f'{url}/telegram/webhook', secret_token=env('TELEGRAM_WEBHOOK_SECRET'), allowed_updates=['message']
    )
    return url
