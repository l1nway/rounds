import contextlib
import itertools
import math
from collections import deque
from functools import cache

import torch
import torch.nn.functional as F

from . import fastdvdnet, zerodce, zerodce_np
from .color import GAMMA
from .config import DCE_WEIGHTS, DVD_WEIGHTS, FPS
from .look_np import REPAIR_EPS as EPS
from .look_np import REPAIR_LIFT as LIFT
from .look_np import REPAIR_SCALE as SCALE
from .look_np import REPAIR_TAU as TAU

# [DOC: repair]
SIGMA_MAX = 15 / 255
ALIGN = 4


def load() -> tuple:
    return fastdvdnet.load(DVD_WEIGHTS), zerodce.load(DCE_WEIGHTS)


def to(nets: tuple, device) -> tuple:
    dvd, dce = nets
    device = torch.device(device)
    return dvd.to(device, torch.half if device.type == 'cuda' else torch.float), dce.to(device)


@cache
def cached(device) -> tuple:
    return to(load(), device)


def triples(seq, pad: int):
    win = deque(maxlen=3)
    for x in seq:
        win.extend([x] * (pad + 1) if not win else [x])
        if len(win) == 3:
            yield tuple(win)
    for _ in range(pad if win else 0):
        win.append(win[-1])
        yield tuple(win)


def stage(block, seq, pad: int, sigma: float):
    noise = None
    for a, b, c in triples(seq, pad):
        noise = torch.full_like(b[:, :1], sigma) if noise is None else noise
        yield block(a, b, c, noise)


@torch.inference_mode()
def repair(seq, nets: tuple, strength: float, rate: float, pad: int = 2):
    (dvd, dce), seq = nets, iter(seq)
    if (first := next(seq, None)) is None:
        return
    (h, w), dtype, sigma = first.shape[-2:], next(dvd.parameters()).dtype, strength * SIGMA_MAX
    gamma = (F.pad(x.clamp(0, 1)[None] ** (1 / GAMMA), (0, -w % ALIGN, 0, -h % ALIGN), mode='reflect').to(dtype)
             for x in itertools.chain([first], seq))  # fmt: skip
    ema, k = None, 1 - math.exp(-1 / (rate * TAU))
    for v in stage(dvd.temp2, stage(dvd.temp1, gamma, pad, sigma), 0, sigma):
        v = v[..., :h, :w].float().clamp(0, 1)
        alpha = dce(F.interpolate(v, scale_factor=1 / SCALE, mode='bilinear')).mean(1, keepdim=True)
        ema = alpha if ema is None else ema + k * (alpha - ema)
        alpha = F.interpolate(ema, (h, w), mode='bilinear', align_corners=True) * (strength * LIFT)
        m = v.amax(1, keepdim=True)
        yield (v * zerodce_np.curve(m, alpha) / m.clamp(min=EPS))[0].clamp(0, 1) ** GAMMA


def frames(source, device, strength: float, rate: float):
    with contextlib.closing(source):
        yield from repair(source, cached(device), strength, rate)


def middle(window: list, nets: tuple, strength: float):
    return next(repair(window, nets, strength, FPS, pad=0))
