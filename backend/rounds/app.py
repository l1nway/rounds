import os
from pathlib import Path

import modal

from . import pipeline
from .config import DATA_DIR, DCE_WEIGHTS, DEEP_FILTER, DVD_WEIGHTS, JOBS_DIR, RIFE_WEIGHTS, SEEDVR_CODE

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
# [DOC: upscale]
SEEDVR = 'https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler', '4490bd1f482e026674543386bb2a4d176da245b9'
MODELS_DIR = '/models'
GPU = 'L4'
LIFT_IDLE = 120


def fetch(path: str, url: str, sha: str) -> tuple[str, str]:
    return f'curl -fsSL --create-dirs -o {path} {url}', f'echo "{sha}  {path}" | sha256sum -c'


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
weights = tuple(c for f in ((RIFE_WEIGHTS, *RIFE), *REPAIR) for c in fetch(*f))
seedvr = (f'git init -q {SEEDVR_CODE} && git -C {SEEDVR_CODE} fetch -q --depth 1 {SEEDVR[0]} {SEEDVR[1]}',
          f'git -C {SEEDVR_CODE} checkout -q FETCH_HEAD')  # fmt: skip
voice = (*fetch(DEEP_FILTER, *VOICE), f'chmod +x {DEEP_FILTER} && {DEEP_FILTER} --version')
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
             'segment': lift.segment.remote.aio, 'look': lift.look.remote.aio}  # fmt: skip
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
        from . import render, repair
        from .segment import Segmenter

        self.segmenter, self.nets, self.preview = Segmenter(), repair.load(), render.preview

    @modal.enter(snap=False)
    def to_gpu(self):
        from . import repair

        self.segmenter.to('cuda')
        self.nets = repair.to(self.nets, 'cuda')

    @modal.method()
    def warm(self) -> None:
        pass

    @modal.method()
    def segment(self, job_id: str, at: float, points: list, box: list | None, size: tuple[int, int]) -> dict:
        if not os.path.exists(f'{JOBS_DIR}/{job_id}/proxy.mp4'):
            data.reload()
        return self.segmenter.segment(job_id, at, points, box, size)

    # [DOC: look-preview]
    @modal.method()
    def look(self, job_id: str, at: float, name: str, meta: dict, value: float, ev: float, size: tuple) -> dict:
        src = f'{JOBS_DIR}/{job_id}/{name}'
        if not os.path.exists(src):
            data.reload()
        return self.preview(src, meta, at, value, ev, size, self.nets)


@app.function(image=cpu_image, secrets=secrets)
async def setup() -> str:
    from .bot import get_bot
    from .config import env

    url = await modal.Function.from_name('rounds', 'web').get_web_url.aio()
    await get_bot().set_webhook(
        f'{url}/telegram/webhook', secret_token=env('TELEGRAM_WEBHOOK_SECRET'), allowed_updates=['message']
    )
    return url
