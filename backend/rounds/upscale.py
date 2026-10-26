import contextlib
import math
import os
import sys
from unittest import mock

import torch

from .color import GAMMA
from .config import OUT_SIZE, SEEDVR_CODE

# [DOC: upscale]
WEIGHTS = 'numz/SeedVR2_comfyUI', '09ced71023636e9bc8cdf9cdecfb2625d1e691e8'
DIT, VAE = 'seedvr2_ema_3b_fp16.safetensors', 'ema_vae_fp16.safetensors'
BATCH = 45
CHUNK = 2 * BATCH
ALIGN = 64
SETTINGS = ['--resolution', str(OUT_SIZE), '--batch_size', str(BATCH), '--color_correction', 'wavelet', '--cache_dit',
            '--cache_vae', '--dit_model', DIT]  # fmt: skip


def wanted(meta: dict, options: dict) -> bool:
    return bool(options.get('upscale')) and min(meta['width'], meta['height']) < OUT_SIZE


def side(meta: dict) -> int:
    return min(ALIGN * math.ceil(min(meta['width'], meta['height']) / ALIGN), OUT_SIZE)


def fetch() -> str:
    from huggingface_hub import hf_hub_download

    return os.path.dirname([hf_hub_download(WEIGHTS[0], f, revision=WEIGHTS[1]) for f in (DIT, VAE)][0])


def model():
    folder = fetch()
    sys.path.insert(0, SEEDVR_CODE)
    import inference_cli as cli

    with mock.patch.object(sys, 'argv', ['seedvr2', 'frames', *SETTINGS, '--model_dir', folder]):
        args = cli.parse_arguments()
    cache = {}
    return lambda batch: cli._process_frames_core(batch, args, '0', cli.debug, cache)


def run(net, chunk: list, device):
    out = net(torch.stack(chunk).permute(0, 2, 3, 1).half().cpu())
    for img in out:
        yield img.to(device).permute(2, 0, 1).float().clamp(0, 1) ** GAMMA


def frames(source, device):
    net, chunk = model(), []
    with contextlib.closing(source):
        for rgb in source:
            chunk.append(rgb.clamp(0, 1) ** (1 / GAMMA))
            if len(chunk) == CHUNK:
                yield from run(net, chunk, device)
                chunk = []
    if chunk:
        yield from run(net, chunk, device)
