import contextlib
import itertools
import math
import subprocess
import sys
import threading

import modal
import numpy as np

from . import media, source
from .app import MODELS_DIR, app, image, models
from .config import FLASHVSR_CODE, OUT_SIZE

# [DOC: upscale]
WEIGHTS = 'JunhaoZhuang/FlashVSR-v1.1', '27561b186ded3402d7c975f4fd722e2885b6135f'
DIT, PROJ, DECODER = 'diffusion_pytorch_model_streaming_dmd.safetensors', 'LQ_proj_in.ckpt', 'TCDecoder.ckpt'
PROMPT = f'{FLASHVSR_CODE}/examples/WanVSR/prompt_tensor/posi_prompt.pth'
ALIGN, SCALE, TARGET, STEP = 64, 4, 1536, 128
SETTINGS = {'prompt': '', 'negative_prompt': '', 'cfg_scale': 1.0, 'num_inference_steps': 1, 'seed': 0,
            'is_full_block': False, 'if_buffer': True, 'kv_ratio': 3.0, 'local_range': 11,
            'color_fix': True}  # fmt: skip
SPARSE = 2.0 * 768 * 1280
# [DOC: upscale-chunks]
LEAD, MIN_CHUNK, MAX_CHUNK, WORKERS = 16, 200, 600, 4
GPUS, IDLE = ['L40S', 'A100-40GB', 'A100-80GB'], 60
DEPTH = 65535
RAW = ['-f', 'rawvideo', '-pix_fmt', 'rgb48le']
LOSSLESS = ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'gbrp10le', '-f', 'matroska']
# [DOC: upscale-image]
FLASHVSR = 'https://github.com/OpenImagingLab/FlashVSR', '0d403ee351905cb1d5eb802855cc4c1f0f4cf929'
BSA = 'https://github.com/mit-han-lab/Block-Sparse-Attention', '49d6c39e4dc0303442cda3bb758b3925d4399c49'
TORCH = '--extra-index-url https://download.pytorch.org/whl/cu124 torch==2.6.0 torchvision==0.21.0'
PINNED = 'torch|torchvision|torchaudio|numpy|protobuf|opencv-python'


def clone(path: str, url: str, sha: str) -> str:
    return f'git clone -q {url} {path} && git -C {path} checkout -q {sha}'


cuda = (
    modal.Image.from_registry('nvidia/cuda:12.4.1-devel-ubuntu22.04', add_python='3.12')
    .apt_install('build-essential', 'git', 'libgl1', 'libglib2.0-0')
    .run_commands(
        f'pip install {TORCH} packaging ninja wheel "setuptools<81"',
        clone(FLASHVSR_CODE, *FLASHVSR),
        f"grep -v -E '^({PINNED})==' {FLASHVSR_CODE}/requirements.txt > /tmp/req.txt",
        f'pip install -r /tmp/req.txt modelscope {TORCH}',
        f'pip install --no-build-isolation --no-deps -e {FLASHVSR_CODE}',
        f'{clone("/opt/bsa", *BSA)} && git -C /opt/bsa submodule update --init csrc/cutlass',
        'cd /opt/bsa && CC=gcc CXX=g++ BLOCK_SPARSE_ATTN_FORCE_BUILD=TRUE BLOCK_SPARSE_ATTN_CUDA_ARCHS=80 MAX_JOBS=6'
        ' pip install --no-build-isolation . && rm -rf /opt/bsa',
    )
)
vsr_image = image(base=cuda, commands=('python -m venv --system-site-packages /.uv/.venv',))


def wanted(meta: dict, options: dict) -> bool:
    return bool(options.get('upscale')) and min(meta['width'], meta['height']) < OUT_SIZE


def side(meta: dict) -> int:
    return min(ALIGN * math.ceil(min(meta['width'], meta['height']) / ALIGN), OUT_SIZE)


def plan(n: int) -> list[tuple[int, int, int]]:
    k = max(-(-n // MAX_CHUNK), min(WORKERS, n // MIN_CHUNK), 1)
    edges = [round(i * n / k) for i in range(k + 1)]
    return [(max(0, a - LEAD), a, b) for a, b in itertools.pairwise(edges)]


async def warm(job: dict) -> None:
    request = job['request']
    n = media.frame_count(request['start'], request['end'], source.out_rate(job['meta'], request['options']))
    for _ in range(min(WORKERS, len(plan(n)))):
        await Upscaler().warm.spawn.aio()


def ffmpeg(args: list, data: bytes) -> bytes:
    return subprocess.run(['ffmpeg', '-v', 'error', *args], input=data, capture_output=True, check=True).stdout


def pack(frames: np.ndarray) -> bytes:
    n, h, w, _ = frames.shape
    return ffmpeg([*RAW, '-s', f'{w}x{h}', '-i', '-', *LOSSLESS, '-'], frames.astype('<u2').tobytes())


def unpack(blob: bytes, size: int) -> np.ndarray:
    return np.frombuffer(ffmpeg(['-i', '-', *RAW, '-'], blob), '<u2').reshape(-1, size, size, 3)


def frames(stream, device):
    import torch

    from .color import GAMMA

    with contextlib.closing(stream):
        kept = [(rgb.clamp(0, 1) ** (1 / GAMMA) * DEPTH).round().permute(1, 2, 0).cpu().numpy() for rgb in stream]
    if not kept:
        return
    video, size = np.stack(kept).astype(np.uint16), kept[0].shape[0]
    calls = [Upscaler().run.spawn(pack(video[s:b]), size, a - s, OUT_SIZE) for s, a, b in plan(len(video))]
    for call in calls:
        for img in unpack(call.get(), OUT_SIZE):
            yield (torch.from_numpy(img.astype(np.float32)).to(device).permute(2, 0, 1) / DEPTH) ** GAMMA


def load():
    import torch
    from huggingface_hub import hf_hub_download

    sys.path.insert(0, f'{FLASHVSR_CODE}/examples/WanVSR')
    from diffsynth import FlashVSRTinyLongPipeline, ModelManager
    from utils.TCDecoder import build_tcdecoder
    from utils.utils import Causal_LQ4x_Proj

    dit, proj, decoder = (hf_hub_download(WEIGHTS[0], f, revision=WEIGHTS[1]) for f in (DIT, PROJ, DECODER))
    manager = ModelManager(torch_dtype=torch.bfloat16, device='cpu')
    manager.load_models([dit])
    pipe = FlashVSRTinyLongPipeline.from_model_manager(manager, device='cuda')
    lq = Causal_LQ4x_Proj(in_dim=3, out_dim=1536, layer_num=1)
    lq.load_state_dict(torch.load(proj, map_location='cpu'), strict=True)
    pipe.denoising_model().LQ_proj_in = lq.to('cuda', dtype=torch.bfloat16)
    pipe.TCDecoder = build_tcdecoder(new_channels=[512, 256, 128, 128], new_latent_channels=16 + 768)
    pipe.TCDecoder.load_state_dict(torch.load(decoder, map_location='cpu'), strict=False)
    pipe.to('cuda')
    pipe.enable_vram_management(num_persistent_param_in_dit=None)
    pipe.init_cross_kv(torch.load(PROMPT, map_location='cuda'))
    pipe.load_models_to_device(['dit', 'vae'])
    return pipe


# [DOC: upscale-padding]
def chunk(pipe, blob: bytes, size: int, skip: int, out: int) -> bytes:
    import torch
    import torch.nn.functional as F

    src = unpack(blob, size)
    n, target = len(src), min(SCALE * size // STEP * STEP, TARGET)
    total = -(-(n + 3) // 8) * 8 + 1
    lq = torch.empty(1, 3, total, target, target, dtype=torch.bfloat16)
    with torch.inference_mode():
        for i in range(total):
            img = torch.from_numpy(src[min(i, n - 1)].astype(np.float32)).cuda().permute(2, 0, 1)[None] * 2 / DEPTH
            lq[0, :, i] = F.interpolate(img - 1, size=(target, target), mode='bicubic').clamp(-1, 1)[0]
        video = pipe(LQ_video=lq, num_frames=total, height=target, width=target, topk_ratio=SPARSE / target**2,
                     **SETTINGS)  # fmt: skip
    args = [*RAW, '-s', f'{target}x{target}', '-i', '-', '-vf', f'scale={out}:{out}:flags=lanczos', *LOSSLESS, '-']
    enc, done = subprocess.Popen(['ffmpeg', '-v', 'error', *args], stdin=subprocess.PIPE, stdout=subprocess.PIPE), []
    reader = threading.Thread(target=lambda: done.append(enc.stdout.read()))
    reader.start()
    try:
        for img in video.permute(1, 2, 3, 0)[skip:n]:
            px = ((img.float() + 1) * DEPTH / 2).round().clamp(0, DEPTH).to(torch.int32).numpy()
            enc.stdin.write(px.astype('<u2').tobytes())
    except BaseException:
        enc.kill()
        raise
    enc.stdin.close()
    reader.join()
    if enc.wait():
        raise RuntimeError(f'upscale encode failed (ffmpeg exit {enc.returncode})')
    return done[0]


@app.cls(image=vsr_image, gpu=GPUS, volumes={MODELS_DIR: models}, cpu=4, memory=32768, timeout=1800,
         max_containers=WORKERS, scaledown_window=IDLE)  # fmt: skip
class Upscaler:
    @modal.enter()
    def setup(self):
        self.pipe = load()

    @modal.method()
    def warm(self) -> None:
        pass

    @modal.method()
    def run(self, blob: bytes, size: int, skip: int, out: int) -> bytes:
        return chunk(self.pipe, blob, size, skip, out)
